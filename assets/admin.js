// HMI Fashion Store — admin panel
// Data lives in Firestore; access is enforced by firestore.rules (admins/{uid}).
const { db, auth, esc, safeUrl, rs, fmtDate, normalizeProduct, normalizeOrder, payLabel, toast } = HMI;
const FieldValue = firebase.firestore.FieldValue;
const $ = (id) => document.getElementById(id);

let products = [];      // normalized, from /products
let categories = [];    // from /categories, sorted by .order
let orders = [];        // normalized, from /orders
let customers = [];     // from /users
let paySettings = HMI.pricing.paySettings();
let editingId = null;
let formImages = [];
const unsubs = [];
const SECTIONS = ['dashboard', 'orders', 'products', 'addProduct', 'categories', 'customers', 'payment', 'data'];

// =====================================================================
// LOGIN
// =====================================================================
function showLoginError(msg) {
  const el = $('loginErr');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
function friendlyAuthError(e) {
  const map = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/invalid-email': 'Invalid email address.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/popup-closed-by-user': 'Google sign-in window was closed.',
    'auth/network-request-failed': 'Check your internet connection.',
    'auth/configuration-not-found': 'Firebase Authentication is not enabled yet (Console → Authentication → Get started).',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase (Authentication → Sign-in method).',
    'auth/unauthorized-domain': 'This domain is not in Firebase Authorized domains.',
  };
  return map[e.code] || e.message;
}

$('loginBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim(), pass = $('loginPass').value;
  if (!email || !pass) return showLoginError('Enter both email and password.');
  $('loginBtn').disabled = true;
  try { await auth.signInWithEmailAndPassword(email, pass); showLoginError(''); }
  catch (e) { showLoginError(friendlyAuthError(e)); }
  finally { $('loginBtn').disabled = false; }
});
$('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
$('googleBtn').addEventListener('click', async () => {
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); showLoginError(''); }
  catch (e) { showLoginError(friendlyAuthError(e)); }
});
$('forgotBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  if (!email) return showLoginError('Enter your email above first, then tap this button.');
  try { await auth.sendPasswordResetEmail(email); showLoginError(''); toast('📧 Password reset link sent to your email'); }
  catch (e) { showLoginError(friendlyAuthError(e)); }
});

function adminLogout() {
  unsubs.splice(0).forEach((u) => u());
  auth.signOut().then(() => location.reload());
}

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    $('loginOverlay').style.display = 'flex';
    $('loginForm').style.display = 'block';
    $('notAdminBox').style.display = 'none';
    $('appShell').style.display = 'none';
    return;
  }
  let isAdmin = false;
  try { isAdmin = (await db.collection('admins').doc(user.uid).get()).exists; } catch (e) { isAdmin = false; }
  if (!isAdmin) {
    $('loginForm').style.display = 'none';
    $('notAdminBox').style.display = 'block';
    $('naEmail').textContent = user.email || user.phoneNumber || '—';
    $('naUid').textContent = user.uid;
    return;
  }
  $('loginOverlay').style.display = 'none';
  $('appShell').style.display = 'block';
  $('adminEmail').textContent = user.email || 'Admin';
  startApp();
});

// =====================================================================
// NAVIGATION
// =====================================================================
function showSection(name) {
  if (!SECTIONS.includes(name)) name = 'dashboard';
  sessionStorage.setItem('hmi_admin_section', name);
  SECTIONS.forEach((s) => { $('sec-' + s).style.display = s === name ? 'block' : 'none'; });
  document.querySelectorAll('.side-btn[data-sec]').forEach((b) => b.classList.toggle('active', b.dataset.sec === name));
  if (name === 'payment') fillPayForm();
  if (name === 'data') renderImportStatus();
  window.scrollTo(0, 0);
}
function buildNav() {
  $('mobileNav').innerHTML = document.querySelector('.sidebar').innerHTML
    .replace(/<div class="sidebar-title">.*?<\/div>/, '').replace(/ id="[^"]*"/g, '');
  document.querySelectorAll('.side-btn[data-sec]').forEach((b) =>
    b.addEventListener('click', () => (b.dataset.sec === 'addProduct' ? newProduct() : showSection(b.dataset.sec))));
}

// =====================================================================
// LIVE DATA
// =====================================================================
function startApp() {
  if (unsubs.length) return;
  buildNav();
  resetPinFromLink();
  showSection(sessionStorage.getItem('hmi_admin_section') || 'dashboard');
  const onErr = (what) => (e) => { console.error(what, e); toast('❌ ' + what + ' failed to load: ' + e.message, 'error'); };

  unsubs.push(db.collection('products').onSnapshot((snap) => {
    products = snap.docs.map((d) => normalizeProduct(d.id, d.data()))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.name.localeCompare(b.name));
    renderAll();
  }, onErr('Products')));

  unsubs.push(db.collection('categories').onSnapshot((snap) => {
    categories = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    renderCategoryControls();
    renderAll();
  }, onErr('Categories')));

  let firstOrders = true;
  unsubs.push(db.collection('orders').onSnapshot((snap) => {
    if (!firstOrders) {
      snap.docChanges().filter((c) => c.type === 'added')
        .forEach((c) => toast('🔔 New order: ' + (c.doc.data().orderNo || c.doc.id)));
    }
    firstOrders = false;
    orders = snap.docs.map((d) => normalizeOrder(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
    renderAll();
    if ($('orderDetailOverlay').style.display === 'flex' && openOrderId) openOrderDetail(openOrderId);
  }, onErr('Orders')));

  unsubs.push(db.collection('users').onSnapshot((snap) => {
    customers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  }, onErr('Customers')));

  unsubs.push(db.collection('settings').doc('payment').onSnapshot((d) => {
    paySettings = HMI.pricing.paySettings(d.exists ? d.data() : null);
    if ($('sec-payment').style.display !== 'none' && !payFormDirty) fillPayForm();
  }, onErr('Settings')));

  ['orderSearch', 'orderStatusFilter'].forEach((id) => $(id).addEventListener('input', renderOrders));
  ['productSearch', 'catFilter', 'stockFilter'].forEach((id) => $(id).addEventListener('input', renderProducts));
  $('customerSearch').addEventListener('input', renderCustomers);
  ['ps-shipping', 'ps-freeAbove', 'ps-codEnabled', 'ps-codCharge', 'ps-advanceType', 'ps-advanceValue']
    .forEach((id) => $(id).addEventListener('input', () => { payFormDirty = true; renderPayPreview(); }));
  $('imgInput').addEventListener('change', (e) => handleImageUpload(e.target));
}

function renderAll() {
  renderDashboard();
  renderOrders();
  renderProducts();
  renderCategories();
  renderCustomers();
  $('cnt-products').textContent = products.length;
  $('cnt-pending').textContent = orders.filter((o) => o.status === 'Pending').length;
  $('cnt-customers').textContent = customers.length;
}

// =====================================================================
// FORGOT PIN: the customer's WhatsApp message has an admin.html#resetpin=<number> link
// =====================================================================
async function resetPinFromLink() {
  const phone = (location.hash.match(/^#resetpin=(\d{10})$/) || [])[1];
  if (!phone) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (!confirm(`Reset the login PIN for +91 ${phone}?\n\nFirst check that this WhatsApp request came from this same number (+91 ${phone}).`)) return;
  try {
    await HMI.callWorker('/admin/reset-pin', { phone });
    toast('🔑 PIN reset for +91 ' + phone);
    if (confirm('PIN reset ✅\n\nOpen WhatsApp to tell the customer?')) {
      const text = 'Hello! Your HMI Fashion login PIN has been reset. Please open the website, tap Log in → "Generate PIN" and choose a new PIN with the same number. Your orders are safe.';
      location.href = `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
    }
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}

// =====================================================================
// DASHBOARD
// =====================================================================
function statusPill(s) {
  const cls = { Pending: 'os-pending', Confirmed: 'os-confirmed', Shipped: 'os-shipped', Delivered: 'os-delivered', Cancelled: 'os-cancelled' }[s] || 'os-pending';
  return `<span class="${cls}">${HMI.STATUS_ICON[s] || ''} ${esc(s)}</span>`;
}
function payChip(o) {
  const p = o.payment;
  const ok = p.status === 'paid' || p.status === 'advance_paid' || (p.method === 'cod' && !p.advance);
  return `<span class="pay-chip ${ok ? 'pay-ok' : 'pay-wait'}">${esc(payLabel(p))}</span>`;
}
function productThumb(p) {
  const src = p.images && p.images[0] && safeUrl(p.images[0]);
  return src ? `<img src="${src}" class="prod-img-cell" alt="">`
    : `<div class="prod-emoji-cell" style="background:${esc(p.bg || '#fce7f3')}">${esc(p.emoji || '👗')}</div>`;
}

function renderDashboard() {
  const live = orders.filter((o) => o.status !== 'Cancelled');
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  $('st-revenue').textContent = rs(live.reduce((a, o) => a + o.total, 0));
  $('st-orders').textContent = orders.length;
  $('st-pending').textContent = orders.filter((o) => o.status === 'Pending').length;
  $('st-today').textContent = orders.filter((o) => o.createdAt >= +startOfDay).length;
  $('st-products').textContent = products.filter((p) => p.active).length;
  const tracked = products.filter((p) => p.trackStock && p.active);
  $('st-low').textContent = tracked.filter((p) => p.stock > 0 && p.stock <= 5).length;
  $('st-out').textContent = tracked.filter((p) => p.stock <= 0).length;
  $('st-customers').textContent = customers.length;

  $('dashOrders').innerHTML = orders.slice(0, 8).map((o) => `
    <tr style="cursor:pointer" onclick="openOrderDetail('${esc(o.id)}')">
      <td><b style="color:var(--pink-deep)">${esc(o.orderNo)}</b></td>
      <td>${esc(o.customerName || '—')}</td>
      <td><b>${rs(o.total)}</b></td>
      <td>${payChip(o)}</td>
      <td>${statusPill(o.status)}</td>
      <td style="font-size:.78rem;color:var(--gray)">${fmtDate(o.createdAt)}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty-state">No orders yet</td></tr>';

  const low = tracked.filter((p) => p.stock <= 5).sort((a, b) => a.stock - b.stock).slice(0, 10);
  $('dashLowStock').innerHTML = low.map((p) => `
    <tr><td>${productThumb(p)}</td><td><b>${esc(p.name)}</b></td>
      <td>${stockCell(p)}</td>
      <td><button class="btn btn-outline btn-sm" type="button" onclick="editProduct('${esc(p.id)}')">✏️ Edit</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="empty-state">All products are well stocked 👍</td></tr>';

  const needsImport = products.length === 0;
  $('importNudge').style.display = needsImport ? 'block' : 'none';
}

// =====================================================================
// ORDERS
// =====================================================================
function renderOrders() {
  const q = $('orderSearch').value.trim().toLowerCase();
  const st = $('orderStatusFilter').value;
  const list = orders.filter((o) => (st === 'all' || o.status === st)
    && (!q || [o.orderNo, o.customerName, o.customerPhone, o.email].join(' ').toLowerCase().includes(q)));
  $('emptyOrders').style.display = list.length ? 'none' : 'block';
  $('ordersBody').innerHTML = list.map((o) => `
    <tr>
      <td><b style="color:var(--pink-deep);font-size:.82rem;">${esc(o.orderNo)}</b>${o.legacy ? '<br><span class="help">legacy</span>' : ''}</td>
      <td><b>${esc(o.customerName || '—')}</b><br><span class="help">${esc(o.customerPhone || o.email || '')}</span></td>
      <td style="font-size:.8rem;color:var(--gray)">${o.items.reduce((a, i) => a + i.qty, 0)} item</td>
      <td><b style="color:var(--pink-deep)">${rs(o.total)}</b><br>${payChip(o)}</td>
      <td style="font-size:.75rem;color:var(--gray)">${fmtDate(o.createdAt)}</td>
      <td>${statusPill(o.status)}</td>
      <td><button class="btn btn-outline btn-sm" type="button" onclick="openOrderDetail('${esc(o.id)}')">👁️ View</button></td>
    </tr>`).join('');
}

let openOrderId = null;
function openOrderDetail(id) {
  const o = orders.find((x) => x.id === id);
  if (!o) return;
  openOrderId = id;
  const cur = HMI.STATUS.indexOf(o.status);
  const timeline = HMI.STATUS.map((s, i) => `
    <div class="stl-step"><div class="stl-dot ${i <= cur ? 'done' : ''}">${i <= cur ? HMI.STATUS_ICON[s] : '○'}</div>
      <div class="stl-label ${i <= cur ? 'done' : ''}">${s}${o.statusTimes[s] ? '<br>' + fmtDate(o.statusTimes[s], false) : ''}</div>
      <div class="stl-line ${i < cur ? 'done' : ''}"></div></div>`).join('');
  const nextBtns = [
    { s: 'Confirmed', label: '✅ Confirm', cls: 's-confirmed' },
    { s: 'Shipped', label: '🚚 Shipped', cls: 's-shipped' },
    { s: 'Delivered', label: '📬 Delivered', cls: 's-delivered' },
    { s: 'Cancelled', label: '❌ Cancel', cls: 's-cancelled' },
  ].filter((b) => b.s !== o.status && o.status !== 'Cancelled')
    .map((b) => `<button class="status-btn ${b.cls}" type="button" onclick="setOrderStatus('${esc(o.id)}','${b.s}')">${b.label}</button>`).join('');
  const items = o.items.map((i) => {
    const img = safeUrl(i.image);
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px;background:#fff9fb;border-radius:10px;margin-bottom:8px;border:1.5px solid var(--pink-light);">
      <div style="width:42px;height:42px;border-radius:8px;background:#fce7f3;display:flex;align-items:center;justify-content:center;font-size:1.3rem;overflow:hidden;flex-shrink:0;">
        ${img ? `<img src="${img}" style="width:100%;height:100%;object-fit:cover;" alt="">` : esc(i.emoji)}</div>
      <div style="flex:1;"><div style="font-weight:700;font-size:.85rem;">${esc(i.name)}</div>
        <div class="help">${[i.size && 'Size: ' + esc(i.size), i.color && 'Colour: ' + esc(i.color)].filter(Boolean).join(' · ')}</div></div>
      <div style="text-align:right;"><b style="color:var(--pink-deep)">${rs(i.price * i.qty)}</b><div class="help">${rs(i.price)} × ${i.qty}</div></div></div>`;
  }).join('');
  const p = o.payment;
  const phoneDigits = String(o.customerPhone || '').replace(/\D/g, '').slice(-10);
  const waText = encodeURIComponent(`Hello ${o.customerName || ''}! Update on your HMI Fashion order ${o.orderNo}: ${o.status}.`);
  const canMarkPaid = !o.legacy && ((p.method === 'cod' && p.status !== 'paid') || p.status === 'pending' || p.status === 'advance_pending');

  $('orderDetailContent').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
      <div><div style="font-size:1.1rem;font-weight:800;color:var(--pink-deep);">${esc(o.orderNo)}</div>
        <div class="help">${fmtDate(o.createdAt)}${o.legacy ? ' · legacy order' : ''}</div></div>
      ${statusPill(o.status)}
    </div>
    ${o.stockIssue ? `<div class="warn-banner">⚠️ Some items in this order were out of stock at payment time. Contact the customer to arrange stock or issue a refund.</div>` : ''}
    ${o.status !== 'Cancelled' ? `<div class="detail-box" style="background:#fff9fb;"><div class="status-timeline">${timeline}</div></div>` : ''}
    ${nextBtns ? `<div style="margin-bottom:14px;"><div class="detail-label">Update status</div><div style="display:flex;gap:8px;flex-wrap:wrap;">${nextBtns}</div></div>` : ''}
    <div class="detail-box">
      <div class="detail-label">🚚 Courier / Tracking</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <input type="text" class="mini-input" id="trkCourier" placeholder="Courier (e.g. Delhivery)" value="${esc(o.tracking && o.tracking.courier)}">
        <input type="text" class="mini-input" id="trkId" placeholder="Tracking / AWB no." value="${esc(o.tracking && o.tracking.id)}">
        <input type="url" class="mini-input" id="trkUrl" placeholder="Tracking link (optional)" value="${esc(o.tracking && o.tracking.url)}" style="grid-column:1/-1;">
        <textarea class="mini-input" id="adminNote" placeholder="Note (visible to admins only)" style="grid-column:1/-1;min-height:50px;">${esc(o.adminNote)}</textarea>
      </div>
      <button class="btn btn-blue btn-sm" type="button" style="margin-top:8px;" onclick="saveTracking('${esc(o.id)}')">💾 Save tracking & note</button>
    </div>
    <div class="detail-box">
      <div class="detail-label">👤 Customer</div>
      <b>${esc(o.customerName || '—')}</b><br>
      📱 ${esc(o.customerPhone || '—')}${o.email ? ' · ' + esc(o.email) : ''}<br>
      📍 ${esc(o.addressText || '—')}
      ${phoneDigits.length === 10 ? `<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <a href="https://wa.me/91${phoneDigits}?text=${waText}" target="_blank" rel="noopener" class="btn btn-green btn-sm">💬 WhatsApp</a>
        <a href="tel:+91${phoneDigits}" class="btn btn-blue btn-sm">📞 Call</a></div>` : ''}
    </div>
    <div class="detail-label">🛍️ Items</div>${items}
    <div class="detail-box" style="background:var(--pink-light);">
      <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${rs(o.subtotal)}</span></div>
      <div style="display:flex;justify-content:space-between;"><span>Shipping</span><span>${o.shipping ? rs(o.shipping) : 'FREE'}</span></div>
      ${o.codCharge ? `<div style="display:flex;justify-content:space-between;"><span>COD charge</span><span>${rs(o.codCharge)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;font-weight:800;font-size:1.05rem;border-top:1.5px solid rgba(219,39,119,.2);margin-top:4px;padding-top:4px;"><span>Total</span><span style="color:var(--pink-deep)">${rs(o.total)}</span></div>
    </div>
    <div class="detail-box">
      <div class="detail-label">💳 Payment</div>
      ${esc(payLabel(p))}
      ${p.method === 'cod' ? `<br>Advance: <b>${rs(p.advance)}</b> · Cash on delivery: <b style="color:var(--red)">${rs(p.balance)}</b>` : ''}
      ${p.razorpayPaymentId ? `<br><span class="help">Razorpay payment: ${esc(p.razorpayPaymentId)}</span>` : ''}
      ${p.refundDue ? `<div class="warn-banner" style="margin:8px 0 0;">💸 Customer cancelled this order. Refund <b>${rs(p.refundDue)}</b> (Razorpay Dashboard → Payments → Refund on this payment).</div>` : ''}
      ${canMarkPaid ? `<br><button class="btn btn-green btn-sm" type="button" style="margin-top:8px;" onclick="markPaid('${esc(o.id)}')">✅ Mark fully paid</button>` : ''}
    </div>
    <div style="display:flex;justify-content:flex-end;">
      <button class="btn btn-danger btn-sm" type="button" onclick="deleteOrder('${esc(o.id)}')">🗑️ Delete order</button>
    </div>`;
  $('orderDetailOverlay').style.display = 'flex';
}
function closeOrderDetail() { $('orderDetailOverlay').style.display = 'none'; openOrderId = null; }
$('orderDetailOverlay').addEventListener('click', (e) => { if (e.target.id === 'orderDetailOverlay') closeOrderDetail(); });

async function setOrderStatus(id, status) {
  const o = orders.find((x) => x.id === id);
  if (!o) return;
  const restock = status === 'Cancelled' && o.stockDeducted && !o.stockRestored;
  if (status === 'Cancelled' && !confirm(`Cancel order ${o.orderNo}?${restock ? '\n\nStock for its items will be restored.' : ''}`)) return;
  try {
    const batch = db.batch();
    const update = { status, ['statusTimes.' + status]: Date.now(), updatedAt: Date.now() };
    if (restock) {
      update.stockRestored = true;
      o.items.forEach((i) => {
        const p = products.find((x) => x.id === i.productId);
        if (p && p.trackStock) batch.update(db.collection('products').doc(p.id), { stock: FieldValue.increment(i.qty) });
      });
    }
    batch.update(db.collection('orders').doc(id), update);
    await batch.commit();
    toast(`✅ ${o.orderNo} → ${status}`);
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}
async function saveTracking(id) {
  const tracking = { courier: $('trkCourier').value.trim(), id: $('trkId').value.trim(), url: $('trkUrl').value.trim() };
  if (tracking.url && !/^https?:\/\//i.test(tracking.url)) return toast('❌ Tracking link must start with https://', 'error');
  try {
    await db.collection('orders').doc(id).update({ tracking, adminNote: $('adminNote').value.trim(), updatedAt: Date.now() });
    toast('✅ Tracking saved');
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}
async function markPaid(id) {
  const o = orders.find((x) => x.id === id);
  if (!o || !confirm(`${o.orderNo}: has the full ${rs(o.total)} been received?`)) return;
  try {
    await db.collection('orders').doc(id).update({
      payment: { ...o.payment, status: 'paid', balance: 0, paidAt: Date.now(), markedPaidByAdmin: true }, updatedAt: Date.now(),
    });
    toast('✅ Marked as paid');
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}
async function deleteOrder(id) {
  const o = orders.find((x) => x.id === id);
  if (!o || !confirm(`Permanently delete order ${o.orderNo}?\n\n(Better to "Cancel" it so the record is kept.)`)) return;
  try { await db.collection('orders').doc(id).delete(); closeOrderDetail(); toast('🗑️ Order deleted'); }
  catch (e) { toast('❌ ' + e.message, 'error'); }
}

// =====================================================================
// PRODUCTS
// =====================================================================
function catName(id) { const c = categories.find((x) => x.id === id); return c ? c.name : (id || '—'); }
function stockCell(p) {
  if (!p.trackStock) return '<span class="help">∞ not tracked</span>';
  const cls = p.stock <= 0 ? 'stock-out' : p.stock <= 5 ? 'stock-low' : 'stock-ok';
  return `<span class="stock-cell"><button type="button" title="Decrease by 1" onclick="bumpStock('${esc(p.id)}',-1)">−</button>
    <span class="${cls}">${p.stock}</span>
    <button type="button" title="Increase by 1" onclick="bumpStock('${esc(p.id)}',1)">+</button>
    <button type="button" title="Set stock" onclick="setStock('${esc(p.id)}')">✎</button></span>`;
}
function renderProducts() {
  const q = $('productSearch').value.trim().toLowerCase();
  const cat = $('catFilter').value || 'all';
  const sf = $('stockFilter').value;
  const list = products.filter((p) => (cat === 'all' || p.category === cat)
    && (!q || p.name.toLowerCase().includes(q))
    && (sf === 'all'
      || (sf === 'low' && p.trackStock && p.stock > 0 && p.stock <= 5)
      || (sf === 'out' && p.trackStock && p.stock <= 0)
      || (sf === 'hidden' && !p.active)));
  $('emptyProducts').style.display = list.length ? 'none' : 'block';
  $('productsBody').innerHTML = list.map((p) => `
    <tr class="${p.active ? '' : 'row-inactive'}">
      <td>${productThumb(p)}</td>
      <td><b>${esc(p.name)}</b>${p.badge ? `<br><span class="help">${esc(p.badge)}</span>` : ''}</td>
      <td><span class="cat-tag ${categories.some((c) => c.id === p.category) ? '' : 'missing'}">${esc(catName(p.category))}</span></td>
      <td><span class="price-main">${rs(p.price)}</span>${p.mrp > p.price ? `<br><span class="price-old-s">${rs(p.mrp)}</span>` : ''}</td>
      <td>${stockCell(p)}</td>
      <td><button type="button" class="toggle ${p.active ? 'on' : 'off'}" onclick="toggleField('${esc(p.id)}','active')">${p.active ? '👁️ Visible' : '🙈 Hidden'}</button></td>
      <td><button type="button" class="toggle ${p.cod ? 'on' : 'off'}" onclick="toggleField('${esc(p.id)}','cod')">${p.cod ? '💵 ON' : '🚫 OFF'}</button></td>
      <td style="white-space:nowrap;">
        <button class="btn btn-outline btn-sm" type="button" onclick="editProduct('${esc(p.id)}')">✏️</button>
        <button class="btn btn-danger btn-sm" type="button" onclick="deleteProduct('${esc(p.id)}')">🗑️</button>
      </td>
    </tr>`).join('');
}
async function bumpStock(id, d) {
  const p = products.find((x) => x.id === id);
  if (!p || p.stock + d < 0) return;
  try { await db.collection('products').doc(id).update({ stock: FieldValue.increment(d), updatedAt: Date.now() }); }
  catch (e) { toast('❌ ' + e.message, 'error'); }
}
async function setStock(id) {
  const p = products.find((x) => x.id === id);
  const v = prompt(`Stock for "${p.name}"?`, p.stock);
  if (v === null) return;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) return toast('❌ Enter a number 0 or higher', 'error');
  try { await db.collection('products').doc(id).update({ stock: n, updatedAt: Date.now() }); toast('✅ Stock updated'); }
  catch (e) { toast('❌ ' + e.message, 'error'); }
}
async function toggleField(id, field) {
  const p = products.find((x) => x.id === id);
  try { await db.collection('products').doc(id).update({ [field]: !p[field], updatedAt: Date.now() }); }
  catch (e) { toast('❌ ' + e.message, 'error'); }
}
async function deleteProduct(id) {
  const p = products.find((x) => x.id === id);
  if (!p || !confirm(`Delete "${p.name}"?\n\nTo just hide it, use the "Visibility" button instead.`)) return;
  try { await db.collection('products').doc(id).delete(); toast('🗑️ Product deleted'); }
  catch (e) { toast('❌ ' + e.message, 'error'); }
}

// ---------- Add / edit form ----------
function newProduct() {
  editingId = null;
  $('formTitle').textContent = '➕ New Product';
  $('cancelEdit').style.display = 'none';
  ['p-name', 'p-price', 'p-mrp', 'p-stock', 'p-emoji', 'p-desc', 'imgUrlInput'].forEach((id) => { $(id).value = ''; });
  $('p-cat').value = '';
  $('p-badge').value = 'New 2026';
  $('p-active').checked = true; $('p-trackStock').checked = true; $('p-cod').checked = true;
  selectColorByValue('#fce7f3');
  document.querySelectorAll('#sizeCheckboxes input').forEach((cb) => { cb.checked = ['M', 'L', 'XL'].includes(cb.value); });
  document.querySelectorAll('#colorCheckboxes input').forEach((cb) => { cb.checked = false; });
  formImages = []; renderImagePreviews();
  showSection('addProduct');
}
function editProduct(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  showSection('addProduct');
  editingId = id;
  $('formTitle').textContent = '✏️ Edit: ' + p.name;
  $('cancelEdit').style.display = 'inline-flex';
  $('p-name').value = p.name;
  $('p-cat').value = categories.some((c) => c.id === p.category) ? p.category : '';
  $('p-badge').value = p.badge;
  $('p-price').value = p.price;
  $('p-mrp').value = p.mrp || '';
  $('p-stock').value = p.stock;
  $('p-emoji').value = p.emoji;
  $('p-desc').value = p.desc;
  $('p-active').checked = p.active; $('p-trackStock').checked = p.trackStock; $('p-cod').checked = p.cod;
  selectColorByValue(p.bg);
  // Custom sizes/colours saved on the product but missing from the checkbox list
  p.sizes.forEach((s) => { if (!document.querySelector(`#sizeCheckboxes input[value="${CSS.escape(s)}"]`)) addSizeChip(s); });
  p.colors.forEach((c) => { if (!document.querySelector(`#colorCheckboxes input[value="${CSS.escape(c.name)}"]`)) addColorChip(c.name, c.hex); });
  document.querySelectorAll('#sizeCheckboxes input').forEach((cb) => { cb.checked = p.sizes.includes(cb.value); });
  document.querySelectorAll('#colorCheckboxes input').forEach((cb) => { cb.checked = p.colors.some((c) => c.name === cb.value); });
  formImages = [...p.images]; renderImagePreviews();
}

async function saveProduct() {
  const name = $('p-name').value.trim();
  const category = $('p-cat').value;
  const price = parseInt($('p-price').value, 10);
  const mrp = parseInt($('p-mrp').value, 10) || 0;
  const stock = parseInt($('p-stock').value, 10);
  if (!name) return toast('❌ Enter a product name', 'error');
  if (!category) return toast('❌ Select a category', 'error');
  if (!(price > 0)) return toast('❌ Enter a sale price', 'error');
  if (mrp && mrp < price) return toast('❌ MRP can\'t be lower than the sale price', 'error');
  if ($('p-trackStock').checked && !(Number.isInteger(stock) && stock >= 0)) return toast('❌ Enter stock (0 or more)', 'error');

  const data = {
    name, category, price, mrp,
    stock: Number.isInteger(stock) && stock >= 0 ? stock : 0,
    trackStock: $('p-trackStock').checked,
    active: $('p-active').checked,
    cod: $('p-cod').checked,
    badge: $('p-badge').value,
    desc: $('p-desc').value.trim(),
    emoji: $('p-emoji').value.trim() || '👗',
    bg: $('p-bg').value || '#fce7f3',
    sizes: [...document.querySelectorAll('#sizeCheckboxes input:checked')].map((cb) => cb.value),
    colors: [...document.querySelectorAll('#colorCheckboxes input:checked')].map((cb) => ({ name: cb.value, hex: cb.dataset.hex || '#888' })),
    images: formImages.slice(0, 12),
    updatedAt: Date.now(),
  };
  $('saveProductBtn').disabled = true;
  try {
    if (editingId) {
      await db.collection('products').doc(editingId).set(data, { merge: true });
      toast('✅ Product updated');
    } else {
      await db.collection('products').add({ ...data, createdAt: Date.now() });
      toast('✅ Product added');
    }
    newProduct();
    showSection('products');
  } catch (e) { toast('❌ Save failed: ' + e.message, 'error'); }
  finally { $('saveProductBtn').disabled = false; }
}

// ---------- Sizes, colours, background (markup comes from the old admin) ----------
function addSizeChip(value) {
  const label = document.createElement('label');
  label.className = 'sz-check';
  label.innerHTML = `<input type="checkbox" value="${esc(value)}" checked> ${esc(value)}`;
  $('sizeCheckboxes').appendChild(label);
}
function addColorChip(name, hex) {
  const label = document.createElement('label');
  label.className = 'col-check';
  label.innerHTML = `<input type="checkbox" value="${esc(name)}" data-hex="${esc(hex)}" checked> <span class="col-swatch" style="background:${esc(hex)}"></span> ${esc(name)}`;
  $('colorCheckboxes').appendChild(label);
}
function addCustomSize() {
  const v = $('customSizeInput').value.trim();
  if (!v) return;
  const existing = document.querySelector(`#sizeCheckboxes input[value="${CSS.escape(v)}"]`);
  if (existing) existing.checked = true; else addSizeChip(v);
  $('customSizeInput').value = '';
}
function addCustomColor() {
  const name = $('customColorName').value.trim();
  if (!name) return toast('❌ Enter a colour name', 'error');
  const existing = document.querySelector(`#colorCheckboxes input[value="${CSS.escape(name)}"]`);
  if (existing) existing.checked = true; else addColorChip(name, $('customColorHex').value);
  $('customColorName').value = '';
}
function selectBgColor(el, color) {
  document.querySelectorAll('.color-opt').forEach((o) => o.classList.remove('selected'));
  el.classList.add('selected');
  $('p-bg').value = color;
}
function selectColorByValue(color) {
  const el = document.querySelector(`.color-opt[data-color="${CSS.escape(color || '#fce7f3')}"]`) || document.querySelector('.color-opt');
  selectBgColor(el, el.dataset.color);
}

// ---------- Images ----------
function renderImagePreviews() {
  $('imgPreviewWrap').innerHTML = formImages.map((src, i) => `
    <div class="img-preview"><img src="${safeUrl(src)}" alt="">
      <button class="img-del" type="button" title="Remove" onclick="removeImg(${i})">✕</button>
      ${i > 0 ? `<button class="img-del" type="button" title="Set as main photo" style="left:2px;right:auto;background:var(--blue)" onclick="makeMainImg(${i})">★</button>` : ''}
    </div>`).join('');
}
function removeImg(i) { formImages.splice(i, 1); renderImagePreviews(); }
function makeMainImg(i) { formImages.unshift(formImages.splice(i, 1)[0]); renderImagePreviews(); }
function addImageUrl() {
  const url = $('imgUrlInput').value.trim();
  if (!/^https:\/\//i.test(url)) return toast('❌ Link must start with https://', 'error');
  formImages.push(url); $('imgUrlInput').value = ''; renderImagePreviews();
}
function compressImage(file, maxSize = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      if (scale === 1 && file.size < 1.5 * 1024 * 1024) return resolve(file);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => resolve(b || file), 'image/jpeg', quality);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}
async function handleImageUpload(input) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  if (!HMI.cfg.workerUrl) return toast('❌ Photo upload needs the checkout server. Paste a photo link for now.', 'error');
  for (const [n, file] of files.entries()) {
    toast(`⏳ Uploading photo ${n + 1}/${files.length}...`);
    try {
      const fd = new FormData();
      fd.append('image', await compressImage(file), file.name || 'product.jpg');
      const { url } = await HMI.callWorker('/admin/upload-image', fd);
      formImages.push(url); renderImagePreviews();
    } catch (e) { toast('❌ Upload failed: ' + e.message, 'error'); return; }
  }
  toast('✅ Photos uploaded');
}

// =====================================================================
// CATEGORIES
// =====================================================================
function renderCategoryControls() {
  const opts = categories.map((c) => `<option value="${esc(c.id)}">${esc(c.icon || '')} ${esc(c.name)}</option>`).join('');
  const pc = $('p-cat'), v1 = pc.value;
  pc.innerHTML = '<option value="">Select a category</option>' + opts; pc.value = v1;
  const cf = $('catFilter'), v2 = cf.value;
  cf.innerHTML = '<option value="all">All categories</option>' + opts; cf.value = v2 || 'all';
}
function renderCategories() {
  $('catBody').innerHTML = categories.map((c, i) => `
    <tr><td style="font-size:1.5rem">${esc(c.icon || '🏷️')}</td><td><b>${esc(c.name)}</b></td>
      <td class="help">${esc(c.sub || '—')}</td>
      <td>${products.filter((p) => p.category === c.id).length}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-outline btn-sm" type="button" onclick="moveCategory(${i},-1)" ${i === 0 ? 'disabled' : ''}>⬆️</button>
        <button class="btn btn-outline btn-sm" type="button" onclick="moveCategory(${i},1)" ${i === categories.length - 1 ? 'disabled' : ''}>⬇️</button>
        <button class="btn btn-danger btn-sm" type="button" onclick="deleteCategory('${esc(c.id)}')">🗑️</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="empty-state">No categories — add one above</td></tr>';
}
async function addCategory() {
  const name = $('c-name').value.trim();
  if (!name) return toast('❌ Enter a category name', 'error');
  if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return toast('❌ This category already exists', 'error');
  let id = name.replace(/[^a-zA-Z0-9]/g, '') || 'Cat' + Date.now();
  while (categories.some((c) => c.id === id)) id += '1';
  try {
    await db.collection('categories').doc(id).set({
      name, icon: $('c-icon').value.trim() || '🏷️', sub: $('c-sub').value.trim(),
      order: categories.length ? Math.max(...categories.map((c) => c.order || 0)) + 1 : 0,
    });
    ['c-name', 'c-icon', 'c-sub'].forEach((x) => { $(x).value = ''; });
    toast(`✅ "${name}" added`);
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}
async function deleteCategory(id) {
  const c = categories.find((x) => x.id === id);
  const cnt = products.filter((p) => p.category === id).length;
  if (!confirm(cnt ? `"${c.name}" has ${cnt} products. After deleting, they will only appear under "All".\n\nDelete anyway?` : `Delete "${c.name}"?`)) return;
  try { await db.collection('categories').doc(id).delete(); toast('🗑️ Category deleted'); }
  catch (e) { toast('❌ ' + e.message, 'error'); }
}
async function moveCategory(i, d) {
  const j = i + d;
  if (j < 0 || j >= categories.length) return;
  const list = [...categories];
  [list[i], list[j]] = [list[j], list[i]];
  const batch = db.batch();
  list.forEach((c, k) => batch.update(db.collection('categories').doc(c.id), { order: k }));
  try { await batch.commit(); } catch (e) { toast('❌ ' + e.message, 'error'); }
}

// =====================================================================
// CUSTOMERS
// =====================================================================
function renderCustomers() {
  const q = $('customerSearch').value.trim().toLowerCase();
  const stats = {};
  orders.forEach((o) => {
    if (!o.userId) return;
    const s = stats[o.userId] || (stats[o.userId] = { count: 0, spent: 0 });
    s.count++;
    if (o.status !== 'Cancelled') s.spent += o.total;
  });
  const list = customers
    .filter((c) => !q || [c.name, c.phone, c.email].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $('emptyCustomers').style.display = list.length ? 'none' : 'block';
  $('customersBody').innerHTML = list.map((c) => {
    const s = stats[c.id] || { count: 0, spent: 0 };
    return `<tr><td><b>${esc(c.name || '—')}</b></td><td>${esc(c.phone || '—')}</td>
      <td style="font-size:.8rem">${esc(c.email || '—')}</td><td>${s.count}</td><td><b>${rs(s.spent)}</b></td>
      <td class="help">${fmtDate(c.createdAt, false)}</td></tr>`;
  }).join('');
}

// =====================================================================
// PAYMENT & SHIPPING SETTINGS
// =====================================================================
let payFormDirty = false;
function fillPayForm() {
  const s = paySettings;
  $('ps-shipping').value = s.shipping; $('ps-freeAbove').value = s.freeAbove;
  $('ps-codEnabled').checked = s.codEnabled; $('ps-codCharge').value = s.codCharge;
  $('ps-advanceType').value = s.advanceType; $('ps-advanceValue').value = s.advanceValue;
  payFormDirty = false;
  renderPayPreview();
}
function readPayForm() {
  const n = (id) => Math.max(0, parseInt($(id).value, 10) || 0);
  return HMI.pricing.paySettings({
    shipping: n('ps-shipping'), freeAbove: n('ps-freeAbove'), codEnabled: $('ps-codEnabled').checked,
    codCharge: n('ps-codCharge'), advanceType: $('ps-advanceType').value, advanceValue: n('ps-advanceValue'),
  });
}
function renderPayPreview() {
  const s = readPayForm();
  $('ps-advanceValueWrap').style.display = ['fixed', 'percent'].includes(s.advanceType) ? 'flex' : 'none';
  $('ps-advanceValueLabel').textContent = s.advanceType === 'percent' ? 'Advance % (e.g. 20)' : 'Advance amount (₹)';
  const lines = [{ price: 1000, qty: 1 }];
  const on = HMI.pricing.calcTotals(lines, s, 'prepaid');
  let html = `<b>Online (Razorpay):</b> ₹1,000 + shipping ${on.ship ? rs(on.ship) : 'FREE'} = <b>${rs(on.total)}</b><br>`;
  if (!s.codEnabled) html += '<b>COD:</b> <span style="color:var(--red);font-weight:700">Disabled</span>';
  else {
    const c = HMI.pricing.calcTotals(lines, s, 'cod');
    html += `<b>COD:</b> ₹1,000 + shipping ${c.ship ? rs(c.ship) : 'FREE'} + COD charge ${rs(c.codCharge)} = <b>${rs(c.total)}</b><br>`;
    html += `&nbsp;&nbsp;→ Advance now (online): <b style="color:var(--pink-deep)">${rs(c.advance)}</b><br>`;
    html += `&nbsp;&nbsp;→ Cash on delivery: <b style="color:var(--green)">${rs(c.balance)}</b>`;
  }
  $('payPreview').innerHTML = html;
}
async function savePaySettings() {
  const s = readPayForm();
  if (s.advanceType === 'percent' && s.advanceValue > 100) return toast('❌ Advance % can\'t exceed 100', 'error');
  try {
    await db.collection('settings').doc('payment').set({ ...s, updatedAt: Date.now() });
    payFormDirty = false;
    toast('✅ Settings saved — live on store now');
  } catch (e) { toast('❌ ' + e.message, 'error'); }
}

// =====================================================================
// IMPORT (old single-list format → one document per product) & BACKUP
// =====================================================================
async function readLegacy() {
  const [p, c] = await Promise.all([
    db.collection('settings').doc('products').get(),
    db.collection('settings').doc('categories').get(),
  ]);
  return {
    products: p.exists && Array.isArray(p.data().list) ? p.data().list : [],
    categories: c.exists && Array.isArray(c.data().list) ? c.data().list : [],
  };
}
async function renderImportStatus() {
  $('importStatus').textContent = 'Checking...';
  try {
    const legacy = await readLegacy();
    const already = legacy.products.filter((p) => products.some((x) => x.id === String(p.id))).length;
    $('importStatus').innerHTML = `Old system: <b>${legacy.products.length}</b> products, <b>${legacy.categories.length}</b> categories.<br>
      New system: <b>${products.length}</b> products, <b>${categories.length}</b> categories.
      ${already ? `<br>${already} products already imported (they'll be skipped if you import again).` : ''}`;
  } catch (e) { $('importStatus').textContent = 'Couldn\'t read old data: ' + e.message; }
}
async function importLegacy() {
  $('importBtn').disabled = true;
  try {
    const legacy = await readLegacy();
    if (!legacy.products.length && !legacy.categories.length) return toast('Nothing found in the old system', 'error');
    const batch = db.batch();
    let nCat = 0, nProd = 0, noStock = 0;
    legacy.categories.forEach((c, i) => {
      const id = String(c.id || c.name || '').trim();
      if (!id || categories.some((x) => x.id === id)) return;
      batch.set(db.collection('categories').doc(id), {
        name: c.name || id, icon: c.icon || c.emoji || '🏷️', sub: c.sub || c.subtitle || '', order: i,
      });
      nCat++;
    });
    legacy.products.forEach((raw) => {
      const id = String(raw.id);
      if (!raw.name || products.some((x) => x.id === id)) return;
      const hasQty = Number.isInteger(raw.qty);
      if (!hasQty) noStock++;
      batch.set(db.collection('products').doc(id), {
        name: String(raw.name).slice(0, 200),
        category: raw.cat || '',
        price: Math.max(0, Number(raw.price) || 0),
        mrp: Math.max(0, Number(raw.old) || 0),
        stock: hasQty ? Math.max(0, raw.qty) : 0,
        trackStock: hasQty,
        active: true,
        cod: raw.cod !== false,
        badge: raw.badge || '',
        desc: raw.desc || '',
        emoji: raw.emoji || '👗',
        bg: raw.bg || '#fce7f3',
        sizes: Array.isArray(raw.sizes) ? raw.sizes : [],
        colors: Array.isArray(raw.colors) ? raw.colors : [],
        images: (Array.isArray(raw.images) ? raw.images : []).filter((u) => /^https?:\/\//.test(u)).slice(0, 12),
        createdAt: Date.now() - Number(raw.id || 0), // keeps the old order
        updatedAt: Date.now(),
      });
      nProd++;
    });
    await batch.commit();
    toast(`✅ Imported: ${nProd} products, ${nCat} categories`);
    if (noStock) alert(`${noStock} products had no stock count in the old system.\n\n"Track stock" is turned off for them (unlimited). Set their real stock in the Products list.`);
    renderImportStatus();
  } catch (e) { toast('❌ Import failed: ' + e.message, 'error'); }
  finally { $('importBtn').disabled = false; }
}
async function downloadBackup() {
  try {
    const [p, c, o, s] = await Promise.all(['products', 'categories', 'orders', 'settings'].map((n) => db.collection(n).get()));
    const dump = (snap) => snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    const data = { exportedAt: new Date().toISOString(), products: dump(p), categories: dump(c), orders: dump(o), settings: dump(s) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `hmi-fashion-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { toast('❌ Backup failed: ' + e.message, 'error'); }
}
