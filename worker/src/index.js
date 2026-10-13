// HMI Fashion Store — checkout server (Cloudflare Worker)
//
// The browser never decides prices. This worker:
//   POST /checkout/start     cart + address -> prices from Firestore, Razorpay order (or COD order)
//   POST /checkout/confirm   verifies the Razorpay signature and places the order
//   POST /razorpay/webhook   places the order even if the customer closed the browser after paying
//   POST /orders/cancel      customer cancels a Pending order (stock goes back)
//   POST /admin/upload-image admin product photo upload (ImgBB key stays secret here)
import '../../assets/pricing.js';
import { Firestore } from './firestore.js';
import { verifyIdToken, hmacHex, safeEqual, AuthError } from './google.js';

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
async function requireUser(req, env) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return verifyIdToken(token, env.FIREBASE_PROJECT_ID, { emulator: env.AUTH_EMULATOR === 'true' && !!env.FIRESTORE_EMULATOR_HOST });
}
const str = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

function newOrderNo() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000); // IST date
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  return `HMI-${ymd}-${[...rnd].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

function cleanAddress(a) {
  a = a || {};
  const out = {
    name: str(a.name, 80), phone: str(a.phone, 20).replace(/\D/g, '').slice(-10),
    line1: str(a.line1, 200), line2: str(a.line2, 200), landmark: str(a.landmark, 120),
    city: str(a.city, 80), state: str(a.state, 80), pincode: str(a.pincode, 6), altPhone: str(a.altPhone, 20),
  };
  if (out.name.length < 2) throw new HttpError(400, 'Naam likhein');
  if (!/^[6-9]\d{9}$/.test(out.phone)) throw new HttpError(400, 'Sahi 10-digit mobile number likhein');
  if (out.line1.length < 3) throw new HttpError(400, 'Address likhein');
  if (!out.city || !out.state) throw new HttpError(400, 'City aur state likhein');
  if (!/^[1-9]\d{5}$/.test(out.pincode)) throw new HttpError(400, 'Sahi 6-digit pincode likhein');
  return out;
}

const tracksStock = (p) => (p.trackStock !== undefined ? p.trackStock !== false : Number.isInteger(p.stock));

// Validates the cart against live product data and returns priced lines.
async function priceCart(fs, rawItems, method, transaction) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new HttpError(400, 'Cart khali hai');
  if (rawItems.length > 30) throw new HttpError(400, 'Ek order mein 30 se zyada items nahi');
  // merge identical lines
  const merged = new Map();
  for (const i of rawItems) {
    const productId = str(i.productId, 100), size = str(i.size, 40), color = str(i.color, 40);
    const qty = Number(i.qty);
    if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 10) throw new HttpError(400, 'Cart mein galat quantity hai');
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
    if (!p || p.active === false || !(Number(p.price) > 0)) throw new HttpError(409, 'Ek product ab available nahi hai. Cart refresh karein.');
    const sizes = Array.isArray(p.sizes) ? p.sizes : [];
    const colors = (Array.isArray(p.colors) ? p.colors : []).map((c) => c && c.name);
    if (sizes.length && !sizes.includes(l.size)) throw new HttpError(400, `"${p.name}" ka size chunein`);
    if (colors.length && !colors.includes(l.color)) throw new HttpError(400, `"${p.name}" ka colour chunein`);
    if (!sizes.length) l.size = '';
    if (!colors.length) l.color = '';
    if (method === 'cod' && p.cod === false) throw new HttpError(400, `"${p.name}" par Cash on Delivery nahi hai`);
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
        ? `"${p.name}" ke sirf ${p.stock} piece bache hain`
        : `"${p.name}" out of stock ho gaya`);
    }
  }
  if (method === 'cod' && !settings.codEnabled) throw new HttpError(400, 'Cash on Delivery abhi band hai');
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
        if (!checkout) throw new HttpError(404, 'Checkout nahi mila');
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
          if (mustHaveStock) throw new HttpError(409, `"${p.name}" ab stock mein nahi hai`);
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
  throw new HttpError(503, 'Server busy, dobara try karein');
}

async function razorpayCreateOrder(env, { amount, receipt, notes }) {
  const base = env.RAZORPAY_API_BASE || 'https://api.razorpay.com';
  const res = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) },
    body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt, notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new HttpError(502, 'Payment shuru nahi ho paya: ' + (data.error?.description || res.status));
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
  if (!orderId || !paymentId || !safeEqual(expected, sig)) throw new HttpError(400, 'Payment verify nahi hua');
  const checkout = await fs.get(`checkouts/${orderId}`);
  if (!checkout || checkout.uid !== user.uid) throw new HttpError(404, 'Checkout nahi mila');
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
      if (!order || order.userId !== user.uid) throw new HttpError(404, 'Order nahi mila');
      if (order.status !== 'Pending') throw new HttpError(400, 'Yeh order ab cancel nahi ho sakta. WhatsApp par baat karein.');
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
  throw new HttpError(503, 'Server busy');
}

async function uploadImage(req, env, fs) {
  const user = await requireUser(req, env);
  if (!(await fs.get(`admins/${user.uid}`))) throw new HttpError(403, 'Sirf admin photo upload kar sakta hai');
  const form = await req.formData();
  const file = form.get('image');
  if (!file || typeof file === 'string') throw new HttpError(400, 'Photo nahi mili');
  if (file.size > 8 * 1024 * 1024) throw new HttpError(413, 'Photo 8 MB se chhoti honi chahiye');
  if (!/^image\//.test(file.type || 'image/jpeg')) throw new HttpError(400, 'Sirf photo upload ho sakti hai');
  const fd = new FormData();
  fd.append('image', file, file.name || 'product.jpg');
  const res = await fetch(`${env.IMGBB_API_BASE || 'https://api.imgbb.com'}/1/upload?key=${encodeURIComponent(env.IMGBB_API_KEY)}`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!data.success || !data.data?.url) throw new HttpError(502, 'Photo upload nahi hui: ' + (data.error?.message || res.status));
  return { url: data.data.url };
}

const ROUTES = {
  'POST /checkout/start': checkoutStart,
  'POST /checkout/confirm': checkoutConfirm,
  'POST /razorpay/webhook': razorpayWebhook,
  'POST /orders/cancel': cancelOrder,
  'POST /admin/upload-image': uploadImage,
  'GET /health': async () => ({ ok: true }),
  // Confirms the service account can reach Firestore (no data is returned)
  'GET /health/db': async (req, env, fs) => {
    try { await fs.get('settings/payment'); return { ok: true, database: 'connected' }; }
    catch (e) { console.error(e); throw new HttpError(503, 'Database se connect nahi hua: ' + (e.status || e.message)); }
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
      return reply(env, req, 500, { error: 'Server error, dobara try karein' });
    }
  },
};
