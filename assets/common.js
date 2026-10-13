// HMI Fashion Store — helpers shared by the store (index.html) and admin (admin.html).
// Needs: Firebase compat SDK (app, auth, firestore), assets/config.js, assets/pricing.js
(function () {
  const cfg = window.HMI_CONFIG;
  if (!firebase.apps.length) firebase.initializeApp(cfg.firebase);
  const db = firebase.firestore();
  const auth = firebase.auth();
  // Local testing only: http://localhost:...?emulator=1 talks to the Firebase emulators, never the live store
  if (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('emulator')) {
    db.useEmulator('127.0.0.1', 8085);
    auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    auth.settings.appVerificationDisabledForTesting = true;
    if (!cfg.workerUrl) cfg.workerUrl = 'http://127.0.0.1:8787'; // tests/dev-worker.mjs
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  // Only http(s) and data:image URLs may go into src/href attributes
  function safeUrl(u) {
    const s = String(u || '');
    return /^(https?:\/\/|data:image\/)/i.test(s) ? esc(s) : '';
  }
  function rs(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
  function ts(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (v.toMillis) return v.toMillis();
    return Number(new Date(v)) || 0;
  }
  function fmtDate(v, withTime = true) {
    const t = ts(v);
    if (!t) return '—';
    const d = new Date(t);
    const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    return withTime ? date + ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : date;
  }

  // Products: accept both the new shape and the old single-list shape
  function normalizeProduct(id, p) {
    const stock = Number.isInteger(p.stock) ? p.stock : (Number.isInteger(p.qty) ? p.qty : 0);
    return {
      id: String(id),
      name: p.name || '',
      category: p.category || p.cat || '',
      price: Number(p.price) || 0,
      mrp: Number(p.mrp || p.old) || 0,
      stock,
      trackStock: p.trackStock !== undefined ? p.trackStock !== false : Number.isInteger(p.stock) || Number.isInteger(p.qty),
      images: Array.isArray(p.images) ? p.images.filter(Boolean) : [],
      sizes: Array.isArray(p.sizes) ? p.sizes : [],
      colors: Array.isArray(p.colors) ? p.colors : [],
      cod: p.cod !== false,
      badge: p.badge || '',
      desc: p.desc || '',
      emoji: p.emoji || '👗',
      bg: p.bg || '#fce7f3',
      active: p.active !== false,
      sort: Number(p.sort) || 0,
      createdAt: p.createdAt || 0,
    };
  }
  function inStock(p, qty = 1) { return !p.trackStock || p.stock >= qty; }

  const STATUS = ['Pending', 'Confirmed', 'Shipped', 'Delivered'];
  const STATUS_ICON = { Pending: '🕐', Confirmed: '✅', Shipped: '🚚', Delivered: '📬', Cancelled: '❌' };

  // Orders: accept both new orders (from the checkout worker) and old ones
  function normalizeOrder(id, o) {
    const addr = o.address && typeof o.address === 'object' ? o.address : null;
    return {
      id: String(id),
      orderNo: o.orderNo || String(id),
      userId: o.userId || '',
      status: o.status || 'Pending',
      statusTimes: o.statusTimes || {},
      createdAt: ts(o.createdAt) || ts(o.date),
      customerName: o.customerName || (addr && addr.name) || '',
      customerPhone: o.customerPhone || (addr && addr.phone) || '',
      email: o.email || '',
      addressText: addr
        ? [addr.line1, addr.line2, addr.landmark, addr.city, addr.state].filter(Boolean).join(', ') + (addr.pincode ? ' - ' + addr.pincode : '')
        : (o.address || ''),
      items: (o.items || []).map((i) => ({
        productId: String(i.productId || i.id || ''),
        name: i.name || '', qty: Number(i.qty) || 0, price: Number(i.price) || 0,
        size: i.size || i.selSize || '', color: i.color || i.selColor || '',
        image: i.image || (i.images && i.images[0]) || '', emoji: i.emoji || '👗',
      })),
      subtotal: Number(o.subtotal) || 0,
      shipping: Number(o.shipping) || 0,
      codCharge: Number(o.codCharge) || 0,
      total: Number(o.total) || 0,
      payment: o.payment || {
        method: o.payMethod === 'COD' ? 'cod' : 'manual',
        status: 'unknown',
        advance: Number(o.advancePaid) || 0,
        balance: Number(o.balanceDue) || 0,
      },
      tracking: o.tracking || null,
      adminNote: o.adminNote || '',
      stockDeducted: !!o.stockDeducted,
      stockRestored: !!o.stockRestored,
      stockIssue: !!o.stockIssue,
      cancelledBy: o.cancelledBy || '',
      legacy: !o.userId,
    };
  }

  function payLabel(pay) {
    if (!pay) return '—';
    if (pay.method === 'razorpay') return pay.status === 'paid' ? '✅ Online paid' : '⏳ Online — payment pending';
    if (pay.method === 'cod') {
      if (pay.advance > 0) return pay.status === 'advance_paid' || pay.status === 'paid'
        ? `💵 COD — advance ${rs(pay.advance)} paid` : `💵 COD — advance ${rs(pay.advance)} pending`;
      return '💵 Cash on Delivery';
    }
    return 'UPI/QR (purana order)';
  }

  // Call the checkout worker with the signed-in user's Firebase ID token
  async function callWorker(path, body, opts = {}) {
    if (!cfg.workerUrl) throw new Error('Checkout server abhi set nahi hua (assets/config.js mein workerUrl).');
    const user = auth.currentUser;
    const headers = {};
    if (user) headers.Authorization = 'Bearer ' + (await user.getIdToken());
    let fetchBody = body;
    if (!(body instanceof FormData) && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }
    const res = await fetch(cfg.workerUrl.replace(/\/$/, '') + path, {
      method: opts.method || 'POST', headers, body: fetchBody,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('Server error ' + res.status));
    return data;
  }

  let toastTimer;
  function toast(msg, type = 'success') {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast ' + type + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  window.HMI = {
    cfg, db, auth, esc, safeUrl, rs, ts, fmtDate,
    normalizeProduct, inStock, normalizeOrder, payLabel, STATUS, STATUS_ICON,
    callWorker, toast, pricing: window.HMIPricing,
  };
})();
