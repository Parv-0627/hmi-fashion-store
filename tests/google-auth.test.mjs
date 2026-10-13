// Tests the production (signed) paths of worker/src/google.js with a locally
// generated RSA key standing in for Google's keys. No network access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto';
import { verifyIdToken, getAccessToken } from '../worker/src/google.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const realFetch = globalThis.fetch;
let tokenRequest = null;

before(() => {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=600' } });
    }
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      tokenRequest = init.body;
      return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
    }
    throw new Error('unexpected fetch ' + url);
  };
});
after(() => { globalThis.fetch = realFetch; });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signed(payload, { kid = 'test-kid', key = privateKey } = {}) {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' }) + '.' + b64(payload);
  const sig = createSign('RSA-SHA256').update(head).sign(key).toString('base64url');
  return head + '.' + sig;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: 'https://securetoken.google.com/hmi', aud: 'hmi', sub: 'u1', iat: now(), exp: now() + 600, phone_number: '+919876543210' });

test('accepts a correctly signed Firebase token', async () => {
  const u = await verifyIdToken(signed(good()), 'hmi');
  assert.equal(u.uid, 'u1');
  assert.equal(u.phone, '+919876543210');
});

test('rejects tampered, unsigned, foreign-key and wrong-project tokens', async () => {
  const t = signed(good());
  const [h, , s] = t.split('.');
  await assert.rejects(verifyIdToken(`${h}.${b64({ ...good(), sub: 'admin' })}.${s}`, 'hmi'), /signature/);
  await assert.rejects(verifyIdToken(`${b64({ alg: 'none' })}.${b64(good())}.`, 'hmi'), /Bad token/);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyIdToken(signed(good(), { key: other }), 'hmi'), /signature/);
  await assert.rejects(verifyIdToken(signed(good(), { kid: 'unknown' }), 'hmi'), /Unknown token key/);
  await assert.rejects(verifyIdToken(signed({ ...good(), aud: 'x' }), 'hmi'), /another project/);
  await assert.rejects(verifyIdToken(signed({ ...good(), exp: now() - 10 }), 'hmi'), /expired/);
});

test('service-account token request is a valid RS256 JWT', async () => {
  const sa = { client_email: 'worker@hmi.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  assert.equal(await getAccessToken(JSON.stringify(sa)), 'ya29.test');
  const assertion = new URLSearchParams(tokenRequest).get('assertion');
  const [h, p, s] = assertion.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
});
