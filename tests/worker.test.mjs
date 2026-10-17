// Checkout worker tests: run the worker's fetch handler in Node against the
// Firestore and Auth emulators, with fake Razorpay and ImgBB servers. Run: npm test
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import worker from '../worker/src/index.js';

const PROJECT = 'demo-hmi-worker';
let env, mock, mockUrl;
const razorpayOrders = [];

const ENV = () => ({
  FIREBASE_PROJECT_ID: PROJECT, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085', AUTH_EMULATOR: 'true',
  RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'rzp_secret', RAZORPAY_WEBHOOK_SECRET: 'wh_secret',
  RAZORPAY_API_BASE: mockUrl, IMGBB_API_KEY: 'imgbb_key', IMGBB_API_BASE: mockUrl,
  ALLOWED_ORIGINS: 'http://localhost:5500,https://shop.hmitechnology.co.in',
});

// Unsigned token in the shape the Firebase Auth emulator issues
function token(uid, extra = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [enc({ alg: 'none', typ: 'JWT' }), enc({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, iat: now, exp: now + 3600,
    email: `${uid}@test.local`, ...extra,
  }), ''].join('.');
}

async function call(path, { uid, body, headers = {}, method = 'POST', raw } = {}) {
  const h = { 'Content-Type': 'application/json', Origin: 'http://localhost:5500', ...headers };
  if (uid) h.Authorization = 'Bearer ' + (typeof uid === 'string' ? token(uid) : uid.token);
  const res = await worker.fetch(new Request('https://worker.test' + path, {
    method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  }), ENV());
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}

const sign = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');
const address = { name: 'Asha Verma', phone: '9876543210', line1: 'Flat 4, Green Park', city: 'Delhi', state: 'Delhi', pincode: '110016' };

async function read(path) {
  let out;
  await env.withSecurityRulesDisabled(async (ctx) => { out = (await getDoc(doc(ctx.firestore(), path))).data(); });
  return out;
}
async function write(path, data) {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), path), data));
}

before(async () => {
  mock = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/orders') {
        const o = JSON.parse(body);
        const created = { id: 'order_' + (razorpayOrders.length + 1) + '_' + Date.now(), amount: o.amount, currency: 'INR', receipt: o.receipt };
        razorpayOrders.push({ ...o, id: created.id, auth: req.headers.authorization });
        return res.end(JSON.stringify(created));
      }
      if (req.url.startsWith('/1/upload')) return res.end(JSON.stringify({ success: true, data: { url: 'https://i.ibb.co/test/photo.jpg' } }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host: '127.0.0.1', port: 8085 } });
});
after(async () => { await env.cleanup(); mock.close(); });

beforeEach(async () => {
  await env.clearFirestore();
  razorpayOrders.length = 0;
  await write('settings/payment', { shipping: 99, freeAbove: 3000, codEnabled: true, codCharge: 50, advanceType: 'fixed', advanceValue: 100 });
  await write('products/saree', { name: 'Silk Saree', price: 2500, stock: 5, trackStock: true, active: true, cod: true, sizes: [], colors: [{ name: 'Red', hex: '#f00' }], images: ['https://x/saree.jpg'], category: 'Saree' });
  await write('products/kurti', { name: 'Kurti', price: 500, stock: 1, trackStock: true, active: true, cod: true, sizes: ['M', 'L'], colors: [], images: [], category: 'Kurti' });
  await write('products/sherwani', { name: 'Sherwani', price: 6000, stock: 0, trackStock: false, active: true, cod: false, sizes: [], colors: [], images: [], category: 'Men' });
  await write('products/hidden', { name: 'Hidden', price: 100, stock: 9, trackStock: true, active: false, cod: true, sizes: [], colors: [], images: [], category: 'Men' });
  await write('admins/boss', { email: 'boss@test.local' });
});

// ---------------------------------------------------------------- online payment
test('prices come from the database, not from the browser', async () => {
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'saree', qty: 1, color: 'Red', price: 1 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.placed, false);
  assert.equal(r.data.totals.total, 2599); // 2500 + 99 shipping
  assert.equal(razorpayOrders[0].amount, 259900);
  assert.match(razorpayOrders[0].auth, /^Basic /);
  assert.equal(r.data.razorpay.key, 'rzp_test_key');
  const checkout = await read(`checkouts/${r.data.razorpay.orderId}`);
  assert.equal(checkout.status, 'awaiting_payment');
  assert.equal((await read('products/saree')).stock, 5, 'stock is not touched before payment');
});

test('a forged payment signature is rejected', async () => {
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'saree', qty: 1, color: 'Red' }] } });
  const bad = await call('/checkout/confirm', { uid: 'alice', body: { razorpay_order_id: r.data.razorpay.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'deadbeef' } });
  assert.equal(bad.status, 400);
  assert.equal(await read(`orders/${r.data.orderNo}`), undefined);
});

test('a valid payment places the order once and reduces stock once', async () => {
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'saree', qty: 2, color: 'Red' }] } });
  const id = r.data.razorpay.orderId;
  const body = { razorpay_order_id: id, razorpay_payment_id: 'pay_ok', razorpay_signature: sign('rzp_secret', `${id}|pay_ok`) };
  const ok = await call('/checkout/confirm', { uid: 'alice', body });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.orderNo, r.data.orderNo);
  const order = await read(`orders/${r.data.orderNo}`);
  assert.equal(order.userId, 'alice');
  assert.equal(order.total, 5000); // free shipping above 3000
  assert.equal(order.payment.status, 'paid');
  assert.equal(order.payment.razorpayPaymentId, 'pay_ok');
  assert.equal(order.items[0].color, 'Red');
  assert.equal((await read('products/saree')).stock, 3);

  // browser retries + webhook arrives: still one order, stock unchanged
  const again = await call('/checkout/confirm', { uid: 'alice', body });
  assert.equal(again.data.orderNo, r.data.orderNo);
  const evt = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_ok', order_id: id } } } });
  const wh = await call('/razorpay/webhook', { raw: evt, headers: { 'X-Razorpay-Signature': sign('wh_secret', evt) } });
  assert.equal(wh.status, 200);
  assert.equal((await read('products/saree')).stock, 3);
});

test('another customer cannot confirm my checkout', async () => {
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'saree', qty: 1, color: 'Red' }] } });
  const id = r.data.razorpay.orderId;
  const res = await call('/checkout/confirm', { uid: 'bob', body: { razorpay_order_id: id, razorpay_payment_id: 'p', razorpay_signature: sign('rzp_secret', `${id}|p`) } });
  assert.equal(res.status, 404);
});

test('webhook alone places the order if the customer closed the browser', async () => {
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'kurti', qty: 1, size: 'M' }] } });
  const evt = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_wh', order_id: r.data.razorpay.orderId } } } });
  assert.equal((await call('/razorpay/webhook', { raw: evt, headers: { 'X-Razorpay-Signature': 'nope' } })).status, 400);
  assert.equal((await call('/razorpay/webhook', { raw: evt, headers: { 'X-Razorpay-Signature': sign('wh_secret', evt) } })).status, 200);
  const order = await read(`orders/${r.data.orderNo}`);
  assert.equal(order.payment.razorpayPaymentId, 'pay_wh');
  assert.equal((await read('products/kurti')).stock, 0);
});

// ---------------------------------------------------------------- COD
test('COD with advance goes through Razorpay for the advance only', async () => {
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'cod', address, items: [{ productId: 'saree', qty: 1, color: 'Red' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.totals.total, 2649); // 2500 + 99 + 50
  assert.equal(r.data.payNow, 100);
  assert.equal(razorpayOrders[0].amount, 10000);
  const id = r.data.razorpay.orderId;
  await call('/checkout/confirm', { uid: 'alice', body: { razorpay_order_id: id, razorpay_payment_id: 'pay_adv', razorpay_signature: sign('rzp_secret', `${id}|pay_adv`) } });
  const order = await read(`orders/${r.data.orderNo}`);
  assert.equal(order.payment.status, 'advance_paid');
  assert.equal(order.payment.balance, 2549);
});

test('COD without advance is placed straight away', async () => {
  await write('settings/payment', { shipping: 0, codEnabled: true, codCharge: 0, advanceType: 'none' });
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'cod', address, items: [{ productId: 'saree', qty: 1, color: 'Red' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.placed, true);
  assert.equal(razorpayOrders.length, 0);
  const order = await read(`orders/${r.data.orderNo}`);
  assert.equal(order.payment.status, 'cod_due');
  assert.equal(order.payment.balance, 2500);
  assert.equal((await read('products/saree')).stock, 4);
});

test('COD is refused when the product or the store does not allow it', async () => {
  const p = await call('/checkout/start', { uid: 'alice', body: { method: 'cod', address, items: [{ productId: 'sherwani', qty: 1 }] } });
  assert.equal(p.status, 400);
  assert.match(p.data.error, /Cash on Delivery/);
  await write('settings/payment', { codEnabled: false });
  const s = await call('/checkout/start', { uid: 'alice', body: { method: 'cod', address, items: [{ productId: 'saree', qty: 1, color: 'Red' }] } });
  assert.equal(s.status, 400);
});

// ---------------------------------------------------------------- validation
test('stock, hidden products, sizes and colours are checked', async () => {
  const tooMany = await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'kurti', qty: 2, size: 'M' }] } });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.data.error, /Only 1 left/);
  assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'hidden', qty: 1 }] } })).status, 409);
  assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'nope', qty: 1 }] } })).status, 409);
  assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'kurti', qty: 1 }] } })).status, 400);
  assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'kurti', qty: 1, size: 'XXL' }] } })).status, 400);
  assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'saree', qty: 1 }] } })).status, 400);
  assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'saree', qty: 0, color: 'Red' }] } })).status, 400);
  assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [] } })).status, 400);
  // not tracked = unlimited
  assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'sherwani', qty: 3 }] } })).status, 200);
});

test('address is validated', async () => {
  const items = [{ productId: 'saree', qty: 1, color: 'Red' }];
  for (const bad of [{ ...address, phone: '12345' }, { ...address, pincode: '1100' }, { ...address, name: '' }, { ...address, city: '' }]) {
    assert.equal((await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address: bad, items } })).status, 400);
  }
});

test('login is required and tokens for other projects are refused', async () => {
  const body = { method: 'razorpay', address, items: [{ productId: 'saree', qty: 1, color: 'Red' }] };
  assert.equal((await call('/checkout/start', { body })).status, 401);
  assert.equal((await call('/checkout/start', { uid: { token: 'not.a.token' }, body })).status, 401);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const other = [enc({ alg: 'none' }), enc({ iss: 'https://securetoken.google.com/other', aud: 'other', sub: 'x', iat: now, exp: now + 60 }), ''].join('.');
  assert.equal((await call('/checkout/start', { uid: { token: other }, body })).status, 401);
  const expired = [enc({ alg: 'none' }), enc({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'x', iat: now - 7200, exp: now - 3600 }), ''].join('.');
  assert.equal((await call('/checkout/start', { uid: { token: expired }, body })).status, 401);
});

test('two customers buying the last piece at once: only one gets it', async () => {
  await write('settings/payment', { codEnabled: true, advanceType: 'none', shipping: 0 });
  const body = { method: 'cod', address, items: [{ productId: 'kurti', qty: 1, size: 'L' }] };
  const [a, b] = await Promise.all([call('/checkout/start', { uid: 'alice', body }), call('/checkout/start', { uid: 'bob', body })]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([a.data, b.data]));
  assert.equal((await read('products/kurti')).stock, 0);
});

// ---------------------------------------------------------------- cancel
test('customer cancels own pending order, stock comes back, refund is noted', async () => {
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'razorpay', address, items: [{ productId: 'saree', qty: 2, color: 'Red' }] } });
  const id = r.data.razorpay.orderId;
  await call('/checkout/confirm', { uid: 'alice', body: { razorpay_order_id: id, razorpay_payment_id: 'p1', razorpay_signature: sign('rzp_secret', `${id}|p1`) } });
  assert.equal((await read('products/saree')).stock, 3);
  assert.equal((await call('/orders/cancel', { uid: 'bob', body: { orderNo: r.data.orderNo } })).status, 404);
  const c = await call('/orders/cancel', { uid: 'alice', body: { orderNo: r.data.orderNo } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.refundDue, 5000);
  const order = await read(`orders/${r.data.orderNo}`);
  assert.equal(order.status, 'Cancelled');
  assert.equal(order.payment.refundDue, 5000);
  assert.equal((await read('products/saree')).stock, 5);
  assert.equal((await call('/orders/cancel', { uid: 'alice', body: { orderNo: r.data.orderNo } })).status, 400);
});

test('confirmed orders cannot be cancelled by the customer', async () => {
  await write('settings/payment', { codEnabled: true, advanceType: 'none' });
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'cod', address, items: [{ productId: 'saree', qty: 1, color: 'Red' }] } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const { updateDoc } = await import('firebase/firestore');
    await updateDoc(doc(ctx.firestore(), `orders/${r.data.orderNo}`), { status: 'Confirmed' });
  });
  assert.equal((await call('/orders/cancel', { uid: 'alice', body: { orderNo: r.data.orderNo } })).status, 400);
});

// ---------------------------------------------------------------- admin upload, CORS
test('only admins can upload product photos', async () => {
  const form = () => { const f = new FormData(); f.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'a.jpg'); return f; };
  const send = (uid) => worker.fetch(new Request('https://worker.test/admin/upload-image', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token(uid) }, body: form(),
  }), ENV());
  assert.equal((await send('alice')).status, 403);
  const ok = await send('boss');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).url, 'https://i.ibb.co/test/photo.jpg');
});

test('CORS only for the store origins', async () => {
  const pre = await worker.fetch(new Request('https://worker.test/checkout/start', { method: 'OPTIONS', headers: { Origin: 'https://shop.hmitechnology.co.in' } }), ENV());
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://shop.hmitechnology.co.in');
  const evil = await worker.fetch(new Request('https://worker.test/checkout/start', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), ENV());
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await call('/nope')).status, 404);
});

// The Auth emulator must accept the custom token the worker hands out
async function emulatorSignIn(customToken) {
  const res = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  assert.equal(res.status, 200);
  return { uid: JSON.parse(Buffer.from(customToken.split('.')[1], 'base64url')).uid };
}

// ---------------------------------------------------------------- PIN login
const pinUid = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).uid;

test('PIN login: first time creates the account, next time the same PIN logs in', async () => {
  const first = await call('/pin/login', { body: { phone: '9812345678', pin: '4826' } });
  assert.deepEqual(first.data, { status: 'new' });
  assert.equal(await read('pinLogins/9812345678'), undefined); // nothing saved until confirmed

  const created = await call('/pin/login', { body: { phone: '9812345678', pin: '4826', create: true } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(pinUid(created.data.token), 'pin_9812345678');
  assert.equal((await emulatorSignIn(created.data.token)).uid, 'pin_9812345678');
  const saved = await read('pinLogins/9812345678');
  assert.ok(!JSON.stringify(saved).includes('4826')); // only a salted hash is stored

  const again = await call('/pin/login', { body: { phone: '+91 98123 45678', pin: '4826' } });
  assert.equal(again.status, 200);
  assert.equal(pinUid(again.data.token), 'pin_9812345678');
  // "create" cannot overwrite someone's existing PIN, and is not a way to guess it
  for (const pin of ['7391', '4826']) {
    const r = await call('/pin/login', { body: { phone: '9812345678', pin, create: true } });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /already has a PIN/);
  }
  assert.equal((await read('pinLogins/9812345678')).fails, 0);
});

test('PIN login: easy PINs and bad input are refused', async () => {
  for (const pin of ['1111', '1234', '4321', '9812', '5678']) {
    const r = await call('/pin/login', { body: { phone: '9812345678', pin, create: true } });
    assert.equal(r.status, 400, pin);
    assert.match(r.data.error, /too easy/);
  }
  assert.equal((await call('/pin/login', { body: { phone: '12345', pin: '4826' } })).status, 400);
  assert.equal((await call('/pin/login', { body: { phone: '9812345678', pin: '48' } })).status, 400);
});

test('PIN login: wrong PINs lock the number, longer each time', async () => {
  await call('/pin/login', { body: { phone: '9812345678', pin: '4826', create: true } });
  for (let i = 1; i <= 4; i++) {
    const r = await call('/pin/login', { body: { phone: '9812345678', pin: '0007' } });
    assert.equal(r.status, 401);
    assert.match(r.data.error, new RegExp(`${5 - i} tr`));
  }
  assert.match((await call('/pin/login', { body: { phone: '9812345678', pin: '0007' } })).data.error, /locked/);
  // locked: even the right PIN waits
  const locked = await call('/pin/login', { body: { phone: '9812345678', pin: '4826' } });
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /15 minutes/);

  // after the lock, 5 more mistakes lock for 30 minutes
  const acc = await read('pinLogins/9812345678');
  await write('pinLogins/9812345678', { ...acc, lockedUntil: Date.now() - 1 });
  for (let i = 0; i < 5; i++) await call('/pin/login', { body: { phone: '9812345678', pin: '0007' } });
  assert.match((await call('/pin/login', { body: { phone: '9812345678', pin: '4826' } })).data.error, /30 minutes/);

  // guesses sent all at once are still counted one by one
  await write('pinLogins/9812345678', { ...acc, fails: 0, lockedUntil: 0 });
  const burst = await Promise.all(Array.from({ length: 8 }, () => call('/pin/login', { body: { phone: '9812345678', pin: '0007' } })));
  assert.ok(burst.every((r) => r.status !== 200));
  const wrong = burst.filter((r) => r.status === 401).length;
  assert.ok(wrong <= 5, `${wrong} guesses got through`);
  assert.equal((await read('pinLogins/9812345678')).fails, wrong);
});

test('Forgot PIN: only an admin can reset, then the customer generates a new PIN on the same account', async () => {
  await call('/pin/login', { body: { phone: '9812345678', pin: '4826', create: true } });
  assert.equal((await call('/admin/reset-pin', { uid: 'alice', body: { phone: '9812345678' } })).status, 403);
  assert.equal((await call('/admin/reset-pin', { body: { phone: '9812345678' } })).status, 401);
  const ok = await call('/admin/reset-pin', { uid: 'boss', body: { phone: '9812345678' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(await read('pinLogins/9812345678'), undefined);
  assert.equal((await call('/admin/reset-pin', { uid: 'boss', body: { phone: '9812345678' } })).status, 404);
  const fresh = await call('/pin/login', { body: { phone: '9812345678', pin: '7391', create: true } });
  assert.equal(pinUid(fresh.data.token), 'pin_9812345678');
});

test('the order keeps the district from the address', async () => {
  await write('settings/payment', { codEnabled: true, advanceType: 'none', shipping: 0 });
  const r = await call('/checkout/start', { uid: 'alice', body: { method: 'cod', address: { ...address, district: 'South Delhi' }, items: [{ productId: 'saree', qty: 1, color: 'Red' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await read(`orders/${r.data.orderNo}`)).address.district, 'South Delhi');
});
