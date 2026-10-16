// HMI Fashion Store — checkout server (Cloudflare Worker)
//
// The browser never decides prices. This worker:
//   POST /checkout/start     cart + address -> prices from Firestore, Razorpay order (or COD order)
//   POST /checkout/confirm   verifies the Razorpay signature and places the order
//   POST /razorpay/webhook   places the order even if the customer closed the browser after paying
//   POST /orders/cancel      customer cancels a Pending order (stock goes back)
//   POST /admin/upload-image admin product photo upload (ImgBB key stays secret here)
//   POST /pin/login          free login with mobile number + 4-digit PIN
import '../../assets/pricing.js';
import { Firestore } from './firestore.js';
import { verifyIdToken, hmacHex, safeEqual, AuthError, createCustomToken, sha256Hex } from './google.js';

const { calcTotals, paySettings } = globalThis.HMIPricing;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- helpers
function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { Vary: 'Origin' };
  if (allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function reply(env, req, status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...cors(env, req) },
  });
}
async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'Invalid request'); }
}
const authEmulator = (env) => env.AUTH_EMULATOR === 'true' && !!env.FIRESTORE_EMULATOR_HOST;
async function requireUser(req, env) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return verifyIdToken(token, env.FIREBASE_PROJECT_ID, { emulator: authEmulator(env) });
}
const str = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

function randomCode(n) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join('');
}
function newOrderNo() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000); // IST date
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  return `HMI-${ymd}-${randomCode(6)}`;
}

function cleanAddress(a) {
  a = a || {};
  const out = {
    name: str(a.name, 80), phone: str(a.phone, 20).replace(/\D/g, '').slice(-10),
    line1: str(a.line1, 200), line2: str(a.line2, 200), landmark: str(a.landmark, 120),
    city: str(a.city, 80), state: str(a.state, 80), pincode: str(a.pincode, 6), altPhone: str(a.altPhone, 20),
  };
  if (out.name.length < 2) throw new HttpError(400, 'Please enter your name');
  if (!/^[6-9]\d{9}$/.test(out.phone)) throw new HttpError(400, 'Please enter a valid 10-digit mobile number');
  if (out.line1.length < 3) throw new HttpError(400, 'Please enter your address');
  if (!out.city || !out.state) throw new HttpError(400, 'Please enter your city and state');
  if (!/^[1-9]\d{5}$/.test(out.pincode)) throw new HttpError(400, 'Please enter a valid 6-digit pincode');
  return out;
}

const tracksStock = (p) => (p.trackStock !== undefined ? p.trackStock !== false : Number.isInteger(p.stock));

// Validates the cart against live product data and returns priced lines.
async function priceCart(fs, rawItems, method, transaction) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new HttpError(400, 'Your cart is empty');
  if (rawItems.length > 30) throw new HttpError(400, 'An order cannot have more than 30 items');
  // merge identical lines
  const merged = new Map();
  for (const i of rawItems) {
    const productId = str(i.productId, 100), size = str(i.size, 40), color = str(i.color, 40);
    const qty = Number(i.qty);
    if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 10) throw new HttpError(400, 'Your cart has an invalid quantity');
    const key = [productId, size, color].join('|');
    const prev = merged.get(key);
    merged.set(key, { productId, size, color, qty: (prev ? prev.qty : 0) + qty });
  }
  const lines = [...merged.values()];
  const ids = [...new Set(lines.map((l) => l.productId))];
  const [settingsDoc, ...docs] = await fs.getMany(['settings/payment', ...ids.map((id) => `products/${id}`)], transaction);
  const products = Object.fromEntries(ids.map((id, k) => [id, docs[k]]));
  const settings = paySettings(settingsDoc);

  const needed = {};
  const priced = lines.map((l) => {
    const p = products[l.productId];
    if (!p || p.active === false || !(Number(p.price) > 0)) throw new HttpError(409, 'A product is no longer available. Please refresh your cart.');
    const sizes = Array.isArray(p.sizes) ? p.sizes : [];
    const colors = (Array.isArray(p.colors) ? p.colors : []).map((c) => c && c.name);
    if (sizes.length && !sizes.includes(l.size)) throw new HttpError(400, `Please choose a size for "${p.name}"`);
    if (colors.length && !colors.includes(l.color)) throw new HttpError(400, `Please choose a colour for "${p.name}"`);
    if (!sizes.length) l.size = '';
    if (!colors.length) l.color = '';
    if (method === 'cod' && p.cod === false) throw new HttpError(400, `Cash on Delivery is not available for "${p.name}"`);
    needed[l.productId] = (needed[l.productId] || 0) + l.qty;
    return {
      productId: l.productId, name: p.name, price: Math.round(Number(p.price)), qty: l.qty,
      size: l.size, color: l.color, image: (Array.isArray(p.images) && p.images[0]) || '', emoji: p.emoji || '👗',
    };
  });
  for (const [id, qty] of Object.entries(needed)) {
    const p = products[id];
    if (tracksStock(p) && (Number(p.stock) || 0) < qty) {
      throw new HttpError(409, (Number(p.stock) || 0) > 0
        ? `Only ${p.stock} left of "${p.name}"`
        : `"${p.name}" is now out of stock`);
    }
  }
  if (method === 'cod' && !settings.codEnabled) throw new HttpError(400, 'Cash on Delivery is not available right now');
  const totals = calcTotals(priced, settings, method === 'cod' ? 'cod' : 'prepaid');
  return { lines: priced, totals, products, needed };
}

function orderDoc({ orderNo, user, address, lines, totals, method, payment }) {
  const now = Date.now();
  return {
    orderNo, userId: user.uid, email: user.email || '',
    customerName: address.name, customerPhone: address.phone, address,
    items: lines,
    subtotal: totals.sub, shipping: totals.ship, codCharge: totals.codCharge, total: totals.total,
    payment: { method, ...payment },
    status: 'Pending', statusTimes: { Pending: now },
    createdAt: now, updatedAt: now, stockDeducted: true,
  };
}

// Places an order inside a Firestore transaction: re-checks stock, writes the
// order and reduces stock atomically. `checkoutId` makes Razorpay orders idempotent.
async function placeOrder(fs, { build, checkoutId, mustHaveStock }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await fs.beginTransaction();
    try {
      let checkout = null;
      if (checkoutId) {
        [checkout] = await fs.getMany([`checkouts/${checkoutId}`], tx);
        if (!checkout) throw new HttpError(404, 'Checkout not found');
        if (checkout.status === 'done') { await fs.rollback(tx); return { orderNo: checkout.orderNo, already: true }; }
      }
      const order = build(checkout);
      const ids = [...new Set(order.items.map((i) => i.productId))];
      const docs = await fs.getMany(ids.map((id) => `products/${id}`), tx);
      const writes = [];
      let stockIssue = false;
      ids.forEach((id, k) => {
        const p = docs[k];
        if (!p || !tracksStock(p)) return;
        const want = order.items.filter((i) => i.productId === id).reduce((a, i) => a + i.qty, 0);
        const have = Number(p.stock) || 0;
        if (have < want) {
          if (mustHaveStock) throw new HttpError(409, `"${p.name}" is now out of stock`);
          stockIssue = true; // already paid: still place it and tell the admin
        }
        writes.push({ op: 'update', path: `products/${id}`, data: { stock: Math.max(0, have - want), updatedAt: Date.now() } });
      });
      if (stockIssue) order.stockIssue = true;
      writes.push({ op: 'create', path: `orders/${order.orderNo}`, data: order });
      if (checkoutId) writes.push({ op: 'update', path: `checkouts/${checkoutId}`, data: { status: 'done', placedAt: Date.now() } });
      await fs.commit(writes, tx);
      return { orderNo: order.orderNo, already: false };
    } catch (e) {
      await fs.rollback(tx);
      if (e.firestoreStatus !== 'ABORTED' || attempt === 3) throw e; // ABORTED = another order touched the same stock
    }
  }
  throw new HttpError(503, 'Server is busy, please try again');
}

async function razorpayCreateOrder(env, { amount, receipt, notes }) {
  const base = env.RAZORPAY_API_BASE || 'https://api.razorpay.com';
  const res = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
    body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt, notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new HttpError(502, 'Could not start the payment: ' + (data.error?.description || res.status));
  return data;
}

// Completes a Razorpay checkout once payment is proven (browser confirm or webhook)
async function finalizeRazorpay(fs, razorpayOrderId, paymentId) {
  return placeOrder(fs, {
    checkoutId: razorpayOrderId,
    mustHaveStock: false,
    build: (c) => orderDoc({
      orderNo: c.orderNo, user: { uid: c.uid, email: c.email }, address: c.address,
      lines: c.lines, totals: c.totals, method: c.method,
      payment: c.method === 'cod'
        ? { status: 'advance_paid', advance: c.totals.advance, balance: c.totals.balance, razorpayOrderId, razorpayPaymentId: paymentId, paidAt: Date.now() }
        : { status: 'paid', amount: c.totals.total, razorpayOrderId, razorpayPaymentId: paymentId, paidAt: Date.now() },
    }),
  });
}

// ---------------------------------------------------------------- routes
async function checkoutStart(req, env, fs) {
  const user = await requireUser(req, env);
  const body = await readJson(req);
  const method = body.method === 'cod' ? 'cod' : 'razorpay';
  const address = cleanAddress(body.address);
  const { lines, totals } = await priceCart(fs, body.items, method);
  const orderNo = newOrderNo();
  const payNow = method === 'cod' ? totals.advance : totals.total;

  if (payNow <= 0) {
    // COD without advance: place the order straight away
    await placeOrder(fs, {
      mustHaveStock: true,
      build: () => orderDoc({
        orderNo, user, address, lines, totals, method: 'cod',
        payment: { status: 'cod_due', advance: 0, balance: totals.total },
      }),
    });
    return { placed: true, orderNo, totals };
  }

  const rz = await razorpayCreateOrder(env, { amount: payNow, receipt: orderNo, notes: { orderNo, uid: user.uid } });
  await fs.commit([{
    op: 'create', path: `checkouts/${rz.id}`,
    data: { uid: user.uid, email: user.email, orderNo, method, address, lines, totals, payNow, status: 'awaiting_payment', createdAt: Date.now() },
  }]);
  return {
    placed: false, orderNo, totals, payNow,
    razorpay: { key: env.RAZORPAY_KEY_ID, orderId: rz.id, amount: rz.amount, currency: 'INR' },
  };
}

async function checkoutConfirm(req, env, fs) {
  const user = await requireUser(req, env);
  const b = await readJson(req);
  const orderId = str(b.razorpay_order_id, 64), paymentId = str(b.razorpay_payment_id, 64), sig = str(b.razorpay_signature, 128);
  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
  if (!orderId || !paymentId || !safeEqual(expected, sig)) throw new HttpError(400, 'Payment could not be verified');
  const checkout = await fs.get(`checkouts/${orderId}`);
  if (!checkout || checkout.uid !== user.uid) throw new HttpError(404, 'Checkout not found');
  const r = await finalizeRazorpay(fs, orderId, paymentId);
  return { placed: true, orderNo: r.orderNo };
}

async function razorpayWebhook(req, env, fs) {
  const raw = await req.text();
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!safeEqual(expected, req.headers.get('X-Razorpay-Signature'))) throw new HttpError(400, 'Bad signature');
  const evt = JSON.parse(raw);
  const payment = evt.payload?.payment?.entity;
  if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && payment?.order_id) {
    const checkout = await fs.get(`checkouts/${payment.order_id}`);
    if (checkout) await finalizeRazorpay(fs, payment.order_id, payment.id);
  }
  return { ok: true };
}

async function cancelOrder(req, env, fs) {
  const user = await requireUser(req, env);
  const orderNo = str((await readJson(req)).orderNo, 40);
  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await fs.beginTransaction();
    try {
      const [order] = await fs.getMany([`orders/${orderNo}`], tx);
      if (!order || order.userId !== user.uid) throw new HttpError(404, 'Order not found');
      if (order.status !== 'Pending') throw new HttpError(400, 'This order can no longer be cancelled. Please contact us on WhatsApp.');
      const ids = [...new Set(order.items.map((i) => i.productId))];
      const docs = await fs.getMany(ids.map((id) => `products/${id}`), tx);
      const writes = [];
      if (order.stockDeducted && !order.stockRestored) {
        ids.forEach((id, k) => {
          const p = docs[k];
          if (!p || !tracksStock(p)) return;
          const qty = order.items.filter((i) => i.productId === id).reduce((a, i) => a + i.qty, 0);
          writes.push({ op: 'update', path: `products/${id}`, data: { stock: (Number(p.stock) || 0) + qty, updatedAt: Date.now() } });
        });
      }
      const paid = order.payment?.status === 'paid' ? order.total
        : order.payment?.status === 'advance_paid' ? order.payment.advance : 0;
      const now = Date.now();
      writes.push({
        op: 'update', path: `orders/${orderNo}`,
        data: {
          status: 'Cancelled', statusTimes: { ...(order.statusTimes || {}), Cancelled: now }, updatedAt: now,
          stockRestored: true, cancelledBy: 'customer',
          ...(paid > 0 ? { payment: { ...order.payment, refundDue: paid } } : {}),
        },
      });
      await fs.commit(writes, tx);
      return { ok: true, refundDue: paid };
    } catch (e) {
      await fs.rollback(tx);
      if (e.firestoreStatus !== 'ABORTED' || attempt === 3) throw e;
    }
  }
  throw new HttpError(503, 'Server is busy, please try again');
}

async function uploadImage(req, env, fs) {
  const user = await requireUser(req, env);
  if (!(await fs.get(`admins/${user.uid}`))) throw new HttpError(403, 'Only an admin can upload photos');
  const form = await req.formData();
  const file = form.get('image');
  if (!file || typeof file === 'string') throw new HttpError(400, 'No photo received');
  if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'Photo must be smaller than 8 MB');
  if (!/^image\//.test(file.type || 'image/jpeg')) throw new HttpError(400, 'Only image files can be uploaded');
  const fd = new FormData();
  fd.append('image', file, file.name || 'product.jpg');
  const res = await fetch(`${env.IMGBB_API_BASE || 'https://api.imgbb.com'}/1/upload?key=${encodeURIComponent(env.IMGBB_API_KEY)}`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!data.success || !data.data?.url) throw new HttpError(502, 'Photo upload failed: ' + (data.error?.message || res.status));
  return { url: data.data.url };
}

// ---------------------------------------------------------------- PIN login
// Free login without SMS: mobile number + a 4-digit PIN the customer chooses the
// first time. The number is NOT verified, so these accounts are separate from
// SMS-OTP accounts (uid "pin_<number>") and never see an OTP customer's orders.
// Wrong PINs lock the number for longer and longer, so a PIN cannot be guessed.
// Forgot PIN: delete pinLogins/<number> in Firebase Console; the customer sets a
// new PIN and keeps the same account and orders.
const PIN_TRIES = 5;
const PIN_LOCK_MINUTES = 15;

function weakPin(pin, phone) {
  return /^(\d)\1{3}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)
    || phone.startsWith(pin) || phone.endsWith(pin);
}
const pinHash = (salt, pin) => sha256Hex(`${salt}:${pin}`);

async function pinLogin(req, env, fs) {
  const b = await readJson(req);
  const phone = str(b.phone, 20).replace(/\D/g, '').slice(-10), pin = str(b.pin, 10);
  if (!/^[6-9]\d{9}$/.test(phone)) throw new HttpError(400, 'Please enter a valid 10-digit mobile number');
  if (!/^\d{4}$/.test(pin)) throw new HttpError(400, 'PIN must be 4 digits');
  const path = `pinLogins/${phone}`;
  const login = async () => ({
    status: 'ok', token: await createCustomToken(env.FIREBASE_SERVICE_ACCOUNT, `pin_${phone}`, { emulator: authEmulator(env) }),
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await fs.beginTransaction();
    let result;
    try {
      const [acc] = await fs.getMany([path], tx);
      const now = Date.now();
      if (!acc) {
        if (!b.create) { await fs.rollback(tx); return { status: 'new' }; }
        if (weakPin(pin, phone)) throw new HttpError(400, 'This PIN is too easy to guess. Please choose another one.');
        const salt = randomCode(16);
        await fs.commit([{ op: 'create', path, data: { salt, pinHash: await pinHash(salt, pin), fails: 0, lockedUntil: 0, createdAt: now, lastLoginAt: now } }], tx);
        return login();
      }
      if (b.create) {
        throw new HttpError(409, 'This number already has a PIN. Please log in with it, or tap "Forgot PIN?".');
      }
      if (acc.lockedUntil > now) {
        throw new HttpError(429, `Too many wrong PINs. Please try again after ${Math.ceil((acc.lockedUntil - now) / 60000)} minutes, or log in with Google / email.`);
      }
      if (safeEqual(acc.pinHash, await pinHash(acc.salt, pin))) {
        await fs.commit([{ op: 'update', path, data: { fails: 0, lockedUntil: 0, lastLoginAt: now } }], tx);
        return login();
      }
      // Wrong PIN: every PIN_TRIES mistakes lock the number, each lock twice as long (max 1 day)
      const fails = (acc.fails || 0) + 1;
      const lockedUntil = fails % PIN_TRIES === 0
        ? now + Math.min(PIN_LOCK_MINUTES * 2 ** (fails / PIN_TRIES - 1), 24 * 60) * 60000 : 0;
      await fs.commit([{ op: 'update', path, data: { fails, lockedUntil } }], tx);
      const left = PIN_TRIES - (fails % PIN_TRIES);
      result = new HttpError(401, lockedUntil ? 'Wrong PIN. Too many tries, this number is locked for a while.' : `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    } catch (e) {
      await fs.rollback(tx);
      if (e.firestoreStatus !== 'ABORTED' || attempt === 3) throw e; // ABORTED = another login for this number at the same time
      continue;
    }
    throw result;
  }
  throw new HttpError(503, 'Server is busy, please try again');
}

const ROUTES = {
  'POST /checkout/start': checkoutStart,
  'POST /checkout/confirm': checkoutConfirm,
  'POST /razorpay/webhook': razorpayWebhook,
  'POST /orders/cancel': cancelOrder,
  'POST /admin/upload-image': uploadImage,
  'POST /pin/login': pinLogin,
  'GET /health': async () => ({ ok: true }),
  // Confirms the service account can reach Firestore (no data is returned)
  'GET /health/db': async (req, env, fs) => {
    try { await fs.get('settings/payment'); return { ok: true, database: 'connected' }; }
    catch (e) { console.error(e); throw new HttpError(503, 'Could not connect to the database: ' + (e.status || e.message)); }
  },
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });
    const route = ROUTES[`${req.method} ${new URL(req.url).pathname}`];
    if (!route) return reply(env, req, 404, { error: 'Not found' });
    try {
      return reply(env, req, 200, await route(req, env, new Firestore(env)));
    } catch (e) {
      if (e instanceof AuthError) return reply(env, req, 401, { error: e.message });
      if (e instanceof HttpError) return reply(env, req, e.status, { error: e.message });
      console.error(e);
      return reply(env, req, 500, { error: 'Server error, please try again' });
    }
  },
};
