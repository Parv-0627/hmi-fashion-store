// Mobile OTP login tests: the worker's /auth/otp routes against the Firestore
// and Auth emulators. Run: npm test
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import worker from '../worker/src/index.js';

const PROJECT = 'demo-hmi-otp';
const AUTH = 'http://127.0.0.1:9099';
let env;

// Fake "SMS Gateway for Android" cloud API
const sms = { sent: [], fail: false, url: '', notes: [], ntfyFail: false, base: '' };
let smsServer;
const SMS_ENV = () => ({ OTP_DELIVERY: 'sms', SMS_GATEWAY_URL: sms.url, SMS_GATEWAY_USER: 'gwuser', SMS_GATEWAY_PASS: 'gwpass' });

const ENV = (extra = {}) => ({
  FIREBASE_PROJECT_ID: PROJECT, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085', AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  AUTH_EMULATOR: 'true', OTP_DELIVERY: 'screen', ALLOWED_ORIGINS: 'http://localhost:5500', ...extra,
});

let ipCounter = 0;
async function call(path, body, { envExtra, ip } = {}) {
  const res = await worker.fetch(new Request('https://worker.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5500', 'CF-Connecting-IP': ip || `10.0.0.${++ipCounter}` },
    body: JSON.stringify(body),
  }), ENV(envExtra));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const send = (phone, opts) => call('/auth/otp/send', { phone }, opts);
const verify = (phone, code, opts) => call('/auth/otp/verify', { phone, code }, opts);

async function read(path) {
  let out;
  await env.withSecurityRulesDisabled(async (ctx) => { out = (await getDoc(doc(ctx.firestore(), path))).data(); });
  return out;
}
async function patch(path, data) {
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), path), data));
}
async function write(path, data) {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), path), data));
}
// The account the custom token logs into (the browser does signInWithCustomToken;
// that is checked end-to-end in the browser, the emulator here is single-project)
async function signIn(token) {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  assert.equal(claims.aud, 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit');
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, {
    method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ localId: [claims.uid] }),
  }).then((x) => x.json());
  return r.users[0];
}

before(async () => {
  smsServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/ntfy/')) { // fake ntfy server
        if (sms.ntfyFail) { res.statusCode = 500; return res.end('down'); }
        sms.notes.push({ path: req.url, headers: req.headers, body });
        return res.end('{}');
      }
      if (sms.fail) { res.statusCode = 503; return res.end('device offline'); }
      sms.sent.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(body) });
      res.statusCode = 202; res.end('{"id":"m1","state":"Pending"}');
    });
  });
  await new Promise((r) => smsServer.listen(0, '127.0.0.1', r));
  sms.base = `http://127.0.0.1:${smsServer.address().port}`;
  sms.url = `${sms.base}/3rdparty/v1/messages`;
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host: '127.0.0.1', port: 8085 } });
});
after(async () => { await env.cleanup(); smsServer.close(); });
beforeEach(async () => {
  sms.sent.length = 0; sms.fail = false; sms.notes.length = 0; sms.ntfyFail = false;
  await env.clearFirestore();
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
});

test('right OTP logs in with the real phone number, same account every time', async () => {
  const s = await send('98765 43210');
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.match(s.data.devCode, /^\d{6}$/);
  const v = await verify('9876543210', s.data.devCode);
  assert.equal(v.status, 200, JSON.stringify(v.data));
  const user = await signIn(v.data.token);
  assert.equal(user.phoneNumber, '+919876543210');

  await patch('otps/9876543210', { sentAt: 0 }); // skip the resend wait
  const s2 = await send('9876543210');
  const again = await signIn((await verify('9876543210', s2.data.devCode)).data.token);
  assert.equal(again.localId, user.localId);
});

test('the code is stored only as a hash and works once', async () => {
  const s = await send('9876543210');
  const saved = await read('otps/9876543210');
  assert.ok(!JSON.stringify(saved).includes(s.data.devCode));
  assert.equal((await verify('9876543210', s.data.devCode)).status, 200);
  const reuse = await verify('9876543210', s.data.devCode);
  assert.equal(reuse.status, 400);
  assert.match(reuse.data.error, /request an OTP/);
});

test('5 wrong codes lock the OTP, even for the right code afterwards', async () => {
  const s = await send('9876543210');
  const wrong = s.data.devCode === '000000' ? '111111' : '000000';
  const first = await verify('9876543210', wrong);
  assert.equal(first.status, 400);
  assert.match(first.data.error, /4 attempts left/);
  for (let i = 0; i < 3; i++) await verify('9876543210', wrong);
  const fifth = await verify('9876543210', wrong);
  assert.equal(fifth.status, 429);
  const right = await verify('9876543210', s.data.devCode);
  assert.equal(right.status, 429);
  assert.match(right.data.error, /Too many wrong attempts/);
});

test('an expired code is refused', async () => {
  const s = await send('9876543210');
  await patch('otps/9876543210', { expiresAt: Date.now() - 1 });
  const v = await verify('9876543210', s.data.devCode);
  assert.equal(v.status, 400);
  assert.match(v.data.error, /expired/);
});

test('rate limits: resend wait, per number, per IP and per day', async () => {
  assert.equal((await send('9876543210')).status, 200);
  const soon = await send('9876543210');
  assert.equal(soon.status, 429);
  assert.match(soon.data.error, /wait \d+ seconds/);

  for (let i = 0; i < 4; i++) { await patch('otps/9876543210', { sentAt: 0 }); assert.equal((await send('9876543210')).status, 200); }
  await patch('otps/9876543210', { sentAt: 0 });
  const sixth = await send('9876543210');
  assert.equal(sixth.status, 429);
  assert.match(sixth.data.error, /this number/);

  for (let i = 0; i < 10; i++) assert.equal((await send(`70000000${String(i).padStart(2, '0')}`, { ip: '1.2.3.4' })).status, 200);
  const ipBlocked = await send('7000000099', { ip: '1.2.3.4' });
  assert.equal(ipBlocked.status, 429);
  assert.match(ipBlocked.data.error, /Too many OTP requests/);

  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  await write('otpLimits/global', { day: today, count: 300 });
  const busy = await send('6000000000');
  assert.equal(busy.status, 429);
  assert.match(busy.data.error, /busy/);
});

test('admin delivery: code goes to the admin queue, never to the browser', async () => {
  const s = await send('9876543210', { envExtra: { OTP_DELIVERY: 'admin' } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.delivery, 'admin');
  assert.equal(s.data.devCode, undefined);
  const req = await read('otpRequests/9876543210');
  assert.equal(req.phone, '+919876543210');
  assert.equal(req.status, 'pending');
  assert.equal((await verify('9876543210', req.code)).status, 200);
  assert.equal(await read('otpRequests/9876543210'), undefined, 'removed after login');
});

test('screen mode is refused outside the emulators', async () => {
  const r = await send('9876543210', { envExtra: { AUTH_EMULATOR_HOST: '' } });
  assert.equal(r.status, 500);
  assert.match(r.data.error, /test mode/);
});

test('bad input is rejected', async () => {
  assert.equal((await send('12345')).status, 400);
  assert.equal((await send('5876543210')).status, 400);
  assert.equal((await verify('9876543210', '12')).status, 400);
});

test('sms delivery: the gateway phone gets the code, the browser and admin do not', async () => {
  const s = await send('9876543210', { envExtra: SMS_ENV() });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.delivery, 'sms');
  assert.equal(s.data.devCode, undefined);
  assert.equal(sms.sent.length, 1);
  const msg = sms.sent[0];
  assert.equal(msg.auth, 'Basic ' + Buffer.from('gwuser:gwpass').toString('base64'));
  assert.deepEqual(msg.body.phoneNumbers, ['+919876543210']);
  const code = msg.body.textMessage.text.match(/^(\d{6}) is your/)[1];
  assert.match(msg.body.textMessage.text, new RegExp(`@shop\\.hmitechnology\\.co\\.in #${code}$`)); // WebOTP autofill line
  assert.equal(await read('otpRequests/9876543210'), undefined);
  assert.equal((await verify('9876543210', code)).status, 200);
  assert.equal((await read('otpLimits/sms')).count, 1);
});

test('sms delivery falls back to the admin queue when the phone is offline or out of SMS', async () => {
  sms.fail = true;
  const offline = await send('9876543210', { envExtra: SMS_ENV() });
  assert.equal(offline.status, 200, JSON.stringify(offline.data));
  assert.equal(offline.data.delivery, 'admin');
  assert.match((await read('otpRequests/9876543210')).reason, /did not respond/);

  sms.fail = false;
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  await write('otpLimits/sms', { day: today, count: 90 });
  const full = await send('9123456780', { envExtra: SMS_ENV() });
  assert.equal(full.data.delivery, 'admin');
  assert.match((await read('otpRequests/9123456780')).reason, /limit/);
  assert.equal(sms.sent.length, 0);

  const noKeys = await send('9000000001', { envExtra: { ...SMS_ENV(), SMS_GATEWAY_PASS: '' } });
  assert.equal(noKeys.data.delivery, 'admin');
});

test('admin gets a phone notification that opens WhatsApp with the OTP', async () => {
  const ntfy = { OTP_DELIVERY: 'admin', NTFY_URL: `${sms.base}/ntfy`, NTFY_TOPIC: 'hmi-otp-secret' };
  const s = await send('9876543210', { envExtra: ntfy });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const code = (await read('otpRequests/9876543210')).code;
  assert.equal(sms.notes.length, 1);
  const n = sms.notes[0];
  assert.equal(n.path, '/ntfy/hmi-otp-secret');
  assert.equal(n.headers.title, 'Login OTP for +91 9876543210');
  assert.match(n.headers.click, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.ok(decodeURIComponent(n.headers.click).includes(`OTP is ${code}`));
  assert.match(n.body, new RegExp(code));

  // no topic set -> no notification; ntfy down -> login still works
  await send('9123456780', { envExtra: { OTP_DELIVERY: 'admin' } });
  assert.equal(sms.notes.length, 1);
  sms.ntfyFail = true;
  const down = await send('9000000002', { envExtra: ntfy });
  assert.equal(down.status, 200);
  assert.equal((await verify('9000000002', (await read('otpRequests/9000000002')).code)).status, 200);
});
