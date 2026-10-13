// HMI Fashion Store — customer storefront
// Catalogue + account data come from Firestore; orders are placed through the
// checkout worker (it prices the cart and verifies Razorpay payments).
const { db, auth, esc, safeUrl, rs, fmtDate, normalizeProduct, normalizeOrder, payLabel, cfg } = HMI;
const { calcTotals, paySettings: readPay } = HMI.pricing;
const $ = (id) => document.getElementById(id);
const WA = cfg.whatsapp;

const state = {
  products: [], categories: [], settings: readPay(),
  user: null, profile: null,
  cart: [], wishlist: new Set(),
  activeCat: 'all', search: '', sort: 'new',
  step: 1, address: null, payMethod: '', placing: false,
  accountTab: 'orders', orders: [], ordersUnsub: null, profileUnsub: null,
  catalogueReady: false,
};

// =====================================================================
// SMALL HELPERS
// =====================================================================
const findProduct = (id) => state.products.find((p) => p.id === String(id));
const catName = (id) => (state.categories.find((c) => c.id === id) || {}).name || id || '';
const hasMrp = (p) => p.mrp > p.price;
const offPct = (p) => Math.round((1 - p.price / p.mrp) * 100);
const outOfStock = (p) => !HMI.inStock(p, 1);
const cartKey = (id, size, color) => [id, size || '', color || ''].join('|');

function flash(msg, color) {
  const f = $('addedFlash');
  f.textContent = msg;
  f.style.background = color || '';
  f.classList.add('show');
  clearTimeout(flash.t);
  flash.t = setTimeout(() => f.classList.remove('show'), 2200);
}
function lockScroll(on) { document.body.style.overflow = on ? 'hidden' : ''; }
function imgOrEmoji(p, cls = '', style = '') {
  const src = p.images && p.images[0] && safeUrl(p.images[0]);
  return src
    ? `<img src="${src}" alt="${esc(p.name)}" loading="lazy" class="${cls}" style="${style}">`
    : `<span style="font-size:5rem">${esc(p.emoji || '👗')}</span>`;
}

// =====================================================================
// CATALOGUE (live from Firestore, with a fallback to the old single-list format)
// =====================================================================
let legacyLoaded = false;
async function loadLegacyCatalogue() {
  if (legacyLoaded) return;
  legacyLoaded = true;
  try {
    const [p, c] = await Promise.all([db.collection('settings').doc('products').get(), db.collection('settings').doc('categories').get()]);
    if (!state.products.length && p.exists && Array.isArray(p.data().list)) {
      state.products = p.data().list.map((raw) => normalizeProduct(raw.id, raw)).filter((x) => x.active && x.price > 0);
    }
    if (!state.categories.length && c.exists && Array.isArray(c.data().list)) {
      state.categories = c.data().list.map((x, i) => ({ id: String(x.id || x.name), name: x.name || x.id, icon: x.icon || x.emoji || '🏷️', sub: x.sub || '', order: i }));
    }
  } catch (e) { console.error('Legacy catalogue', e); }
  renderCatalogue();
}

function startCatalogue() {
  db.collection('products').onSnapshot((snap) => {
    state.products = snap.docs.map((d) => normalizeProduct(d.id, d.data())).filter((p) => p.active && p.price > 0);
    state.catalogueReady = true;
    if (!state.products.length) loadLegacyCatalogue(); else renderCatalogue();
    syncCartWithProducts();
  }, (e) => { console.error('Products', e); loadLegacyCatalogue(); });

  db.collection('categories').onSnapshot((snap) => {
    const cats = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    if (cats.length) { state.categories = cats; renderCatalogue(); } else loadLegacyCatalogue();
  }, (e) => console.error('Categories', e));

  db.collection('settings').doc('payment').onSnapshot((d) => {
    state.settings = readPay(d.exists ? d.data() : null);
    renderShipTexts(); renderCart();
    if (state.step === 4) renderPayment();
  }, (e) => console.error('Settings', e));
}

function renderCatalogue() {
  renderCategories(); renderProducts(); renderKids();
  $('statProducts').textContent = state.products.length ? state.products.length + '+' : '—';
}

function renderShipTexts() {
  const { shipping, freeAbove } = state.settings;
  $('statShip').textContent = shipping ? '₹' + shipping : 'FREE';
  $('heroShip').textContent = shipping === 0 ? '🚚 Pan India Delivery — FREE!'
    : freeAbove ? `🚚 Delivery ₹${shipping} — ₹${freeAbove.toLocaleString('en-IN')}+ order pe FREE!` : `🚚 Pan India Delivery — Only ₹${shipping}!`;
  $('whyShipTitle').textContent = shipping ? 'Delivery @ ₹' + shipping : 'Free Delivery';
  $('whyShipText').textContent = freeAbove && shipping ? `₹${freeAbove.toLocaleString('en-IN')} se upar FREE delivery` : 'Fast & safe Pan India delivery';
  $('footShip').textContent = shipping ? `🚚 Pan India Delivery — ₹${shipping}` : '🚚 Pan India Delivery — FREE';
}

function productInCat(p, catId) {
  if (catId === 'all') return true;
  const c = state.categories.find((x) => x.id === catId);
  return p.category === catId || (c && p.category === c.name);
}

function renderCategories() {
  const grid = $('categoriesGrid');
  if (state.activeCat !== 'all' && !state.categories.some((c) => c.id === state.activeCat)) state.activeCat = 'all';
  const card = (id, icon, name, sub) => `
    <div class="category-card ${state.activeCat === id ? 'active' : ''}" data-cat="${esc(id)}" role="button" tabindex="0">
      <div class="category-icon">${esc(icon)}</div><h3>${esc(name)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;
  grid.innerHTML = card('all', '🛍️', 'All Items', 'Full Collection')
    + state.categories.map((c) => card(c.id, c.icon || '🏷️', c.name, c.sub)).join('');
}

function visibleProducts() {
  const q = state.search.trim().toLowerCase();
  let list = state.products.filter((p) => productInCat(p, state.activeCat)
    && (!q || [p.name, p.desc, catName(p.category), p.badge].join(' ').toLowerCase().includes(q)));
  const sorters = {
    new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    low: (a, b) => a.price - b.price,
    high: (a, b) => b.price - a.price,
    off: (a, b) => (hasMrp(b) ? offPct(b) : 0) - (hasMrp(a) ? offPct(a) : 0),
  };
  list = list.sort(sorters[state.sort] || sorters.new);
  // in-stock first
  return list.sort((a, b) => Number(outOfStock(a)) - Number(outOfStock(b)));
}

function stockBadge(p) {
  if (!p.trackStock) return '';
  if (p.stock <= 0) return '<span class="qty-badge qty-out">Out of Stock</span>';
  if (p.stock <= 5) return `<span class="qty-badge qty-low">Sirf ${p.stock} bache!</span>`;
  return '<span class="qty-badge qty-instock">In Stock</span>';
}

function renderProducts() {
  const list = visibleProducts();
  const grid = $('productsGrid');
  const isAll = state.activeCat === 'all' && !state.search;
  $('shopTitle').textContent = state.search ? `"${state.search}" ke results` : state.activeCat === 'all' ? 'Latest Collection' : catName(state.activeCat);
  $('shopCount').textContent = list.length + (list.length === 1 ? ' product' : ' products');
  $('shopClear').style.display = isAll ? 'none' : 'inline-flex';
  if (!state.catalogueReady && !state.products.length) return;
  if (!list.length) {
    grid.innerHTML = `<div class="empty-grid"><div style="font-size:3rem;margin-bottom:12px">🛍️</div><p>${state.search ? 'Kuch nahi mila. Doosra word try karein.' : 'Is category mein abhi koi product nahi hai.'}</p></div>`;
    return;
  }
  grid.innerHTML = list.map((p) => {
    const oos = outOfStock(p), wished = state.wishlist.has(p.id);
    return `
    <div class="product-card" data-pdp="${esc(p.id)}" style="cursor:pointer;">
      <div class="product-img" style="background:${esc(p.bg)}">
        ${imgOrEmoji(p, '', 'width:100%;height:100%;object-fit:cover;')}
        ${p.badge ? `<div class="product-badge">${esc(p.badge)}</div>` : ''}
        <button type="button" class="wish-btn ${wished ? 'on' : ''}" data-wish="${esc(p.id)}" aria-label="Wishlist">${wished ? '♥' : '♡'}</button>
      </div>
      <div class="product-info">
        <div class="category-tag">${esc(catName(p.category))}</div>
        <h3>${esc(p.name)}</h3>
        <div class="rating-row">${stockBadge(p)}</div>
        <div class="product-price">
          <span class="price-current">${rs(p.price)}</span>
          ${hasMrp(p) ? `<span class="price-old">${rs(p.mrp)}</span><span class="price-discount">${offPct(p)}% OFF</span>` : ''}
        </div>
        <div class="product-btns">
          <button class="btn-cart" type="button" data-add="${esc(p.id)}" ${oos ? 'disabled' : ''}>${oos ? '❌ Out of Stock' : '🛒 Add to Cart'}</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderKids() {
  const list = state.products.filter((p) => productInCat(p, 'Kids') || /kid/i.test(p.category)).slice(0, 8);
  $('kidsGrid').innerHTML = list.length ? list.map((p) => {
    const src = p.images[0] && safeUrl(p.images[0]);
    return `<div class="kids-card" data-pdp="${esc(p.id)}">
      ${src ? `<img src="${src}" alt="${esc(p.name)}" loading="lazy">` : `<div class="kids-emoji" style="background:${esc(p.bg)}">${esc(p.emoji || '🧒')}</div>`}
      ${p.badge ? `<div class="ktag">${esc(p.badge)}</div>` : ''}
      <div class="koverlay"><h4>${esc(p.name)}</h4><p>${rs(p.price)}</p></div></div>`;
  }).join('') : '<div class="kids-empty">Kids collection jaldi aa raha hai! 😍</div>';
}

// =====================================================================
// PRODUCT DETAIL
// =====================================================================
let pdp = { p: null, size: '', color: '' };
function openPDP(id) {
  const p = findProduct(id);
  if (!p) return;
  pdp = { p, size: p.sizes.length === 1 ? p.sizes[0] : '', color: p.colors.length === 1 ? p.colors[0].name : '' };
  $('pdpHint').textContent = '';
  $('pdpBadge').textContent = p.badge; $('pdpBadge').style.display = p.badge ? 'block' : 'none';
  const imgs = p.images.map(safeUrl).filter(Boolean);
  $('pdpMainImg').innerHTML = imgs.length
    ? `<img src="${imgs[0]}" class="pdp-main-img" id="pdpActiveImg" alt="${esc(p.name)}">`
    : `<div class="pdp-emoji-big" style="background:${esc(p.bg)}">${esc(p.emoji)}</div>`;
  $('pdpThumbs').innerHTML = imgs.length > 1 ? imgs.map((src, i) => `<img src="${src}" class="pdp-thumb ${i ? '' : 'active'}" data-thumb alt="">`).join('') : '';
  $('pdpThumbs').style.display = imgs.length > 1 ? 'flex' : 'none';
  $('pdpCat').textContent = catName(p.category);
  $('pdpName').textContent = p.name;
  $('pdpPriceRow').innerHTML = `<span class="pdp-price">${rs(p.price)}</span>`
    + (hasMrp(p) ? `<span class="pdp-old">${rs(p.mrp)}</span><span class="pdp-disc">${offPct(p)}% OFF</span>` : '')
    + (p.trackStock ? (p.stock <= 0 ? '<span class="pdp-qty-tag qty-out">Out of Stock</span>'
      : p.stock <= 5 ? `<span class="pdp-qty-tag qty-low">Sirf ${p.stock} bache!</span>` : '<span class="pdp-qty-tag qty-instock">In Stock</span>') : '');
  $('pdpDesc').textContent = p.desc || 'Premium quality product from HMI Fashion Store.';
  $('pdpCodTag').innerHTML = state.settings.codEnabled && p.cod
    ? '<span class="pdp-cod-tag yes">💵 Cash on Delivery available</span>'
    : '<span class="pdp-cod-tag no">💳 Sirf online payment</span>';
  $('pdpSizeWrap').style.display = p.sizes.length ? 'block' : 'none';
  $('pdpSizes').innerHTML = p.sizes.map((s) => `<button type="button" class="size-btn ${pdp.size === s ? 'selected' : ''}" data-size="${esc(s)}">${esc(s)}</button>`).join('');
  $('pdpColorWrap').style.display = p.colors.length ? 'block' : 'none';
  $('pdpColors').innerHTML = p.colors.map((c) => `<div style="text-align:center;">
      <div class="color-dot ${pdp.color === c.name ? 'selected' : ''}" style="background:${esc(c.hex)}" title="${esc(c.name)}" data-color="${esc(c.name)}" role="button" tabindex="0"></div>
      <div class="color-name-tag">${esc(c.name)}</div></div>`).join('');
  const oos = outOfStock(p);
  $('pdpAddCart').disabled = oos;
  $('pdpAddCart').style.opacity = oos ? '.5' : '1';
  $('pdpAddCart').textContent = oos ? '❌ Out of Stock' : '🛒 Add to Cart';
  renderPdpWish();
  $('pdpWaBtn').href = `https://wa.me/${WA}?text=${encodeURIComponent(`Hello HMI! Mujhe *${p.name}* (${rs(p.price)}) ke baare mein jaanna hai.`)}`;
  $('pdpOverlay').classList.add('open');
  lockScroll(true);
}
function renderPdpWish() {
  if (!pdp.p) return;
  const on = state.wishlist.has(pdp.p.id);
  $('pdpWish').classList.toggle('on', on);
  $('pdpWish').textContent = on ? '♥' : '♡';
}
function closePDP() { $('pdpOverlay').classList.remove('open'); lockScroll(false); }
function pdpAdd() {
  const p = pdp.p;
  if (!p || outOfStock(p)) return;
  if (p.sizes.length && !pdp.size) { $('pdpHint').textContent = '⚠️ Pehle size chunein'; return; }
  if (p.colors.length && !pdp.color) { $('pdpHint').textContent = '⚠️ Pehle colour chunein'; return; }
  if (addToCart(p, pdp.size, pdp.color)) closePDP();
}

// =====================================================================
// CART (kept in this browser; prices always come from live product data)
// =====================================================================
const CART_KEY = 'hmi_cart_v2';
function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || 'null');
    if (Array.isArray(saved)) return saved;
    const old = JSON.parse(localStorage.getItem('hmi_cart') || '[]'); // previous store version
    localStorage.removeItem('hmi_cart');
    return old.map((i) => ({ productId: String(i.id), size: i.selSize || '', color: i.selColor || '', qty: Number(i.qty) || 1 }));
  } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* storage full or blocked */ }
  const n = state.cart.reduce((a, i) => a + i.qty, 0);
  $('cartCount').textContent = n;
  $('cartCount').style.display = n ? 'flex' : 'none';
}
function cartLines() {
  return state.cart.map((i) => ({ ...i, p: findProduct(i.productId) })).filter((l) => l.p);
}
function qtyInCart(id) { return state.cart.filter((i) => i.productId === id).reduce((a, i) => a + i.qty, 0); }
function addToCart(p, size, color) {
  if (p.trackStock && qtyInCart(p.id) + 1 > p.stock) { flash(`Sirf ${p.stock} piece available hain`, '#dc2626'); return false; }
  const key = cartKey(p.id, size, color);
  const ex = state.cart.find((i) => cartKey(i.productId, i.size, i.color) === key);
  if (ex) { if (ex.qty >= 10) { flash('Ek item ke max 10 piece', '#dc2626'); return false; } ex.qty++; }
  else state.cart.push({ productId: p.id, size: size || '', color: color || '', qty: 1 });
  saveCart(); renderCart();
  flash('✅ Cart mein add ho gaya!');
  return true;
}
function quickAdd(id) {
  const p = findProduct(id);
  if (!p) return;
  if (outOfStock(p)) return flash('❌ Out of stock', '#dc2626');
  if (p.sizes.length > 1 || p.colors.length > 1) return openPDP(id);
  addToCart(p, p.sizes[0] || '', p.colors[0] ? p.colors[0].name : '');
}
function changeQty(index, d) {
  const item = state.cart[index];
  if (!item) return;
  const p = findProduct(item.productId);
  if (d > 0 && p && p.trackStock && qtyInCart(p.id) + 1 > p.stock) return flash(`Sirf ${p.stock} piece available hain`, '#dc2626');
  if (d > 0 && item.qty >= 10) return flash('Ek item ke max 10 piece', '#dc2626');
  item.qty += d;
  if (item.qty <= 0) state.cart.splice(index, 1);
  saveCart(); renderCart();
}
function syncCartWithProducts() {
  if (!state.catalogueReady) return;
  const before = state.cart.length;
  state.cart = state.cart.filter((i) => findProduct(i.productId));
  if (state.cart.length !== before) flash('Cart ka ek product ab available nahi hai, hata diya gaya', '#92650a');
  saveCart(); renderCart();
}

function renderCart() {
  const lines = cartLines();
  const wrap = $('cartItemsWrap');
  if (!lines.length) {
    wrap.innerHTML = '<div class="empty-msg"><div class="big">🛍️</div>Cart khali hai.<br>Kuch pasand aaye toh add karein!</div>';
    $('cartSummaryBox').style.display = 'none';
    return;
  }
  wrap.innerHTML = state.cart.map((l, i) => {
    const p = findProduct(l.productId);
    if (!p) return '';
    const src = p.images[0] && safeUrl(p.images[0]);
    const short = p.trackStock && p.stock < qtyInCart(p.id);
    return `<div class="cart-item">
      ${src ? `<img src="${src}" style="width:56px;height:56px;border-radius:10px;object-fit:cover;flex-shrink:0;" alt="">` : `<div class="cart-item-emoji" style="background:${esc(p.bg)}">${esc(p.emoji)}</div>`}
      <div class="cart-item-info">
        <h4>${esc(p.name)}</h4>
        ${l.size ? `<span class="cart-variant-tag">📐 ${esc(l.size)}</span>` : ''}${l.color ? `<span class="cart-variant-tag">🎨 ${esc(l.color)}</span>` : ''}
        <div class="cart-item-price">${rs(p.price * l.qty)}</div>
        ${short ? `<div style="color:#dc2626;font-size:.72rem;font-weight:700;">Sirf ${p.stock} bache hain — qty kam karein</div>` : ''}
        <div class="cart-item-qty">
          <button class="qty-btn" type="button" data-qty="${i}" data-d="-1" aria-label="Kam">−</button>
          <span class="qty-num">${l.qty}</span>
          <button class="qty-btn" type="button" data-qty="${i}" data-d="1" aria-label="Zyada">+</button>
        </div>
      </div>
      <button class="remove-item" type="button" data-remove="${i}" aria-label="Hatao">🗑️</button>
    </div>`;
  }).join('');
  const t = calcTotals(lines.map((l) => ({ price: l.p.price, qty: l.qty })), state.settings, 'prepaid');
  $('subtotalAmt').textContent = rs(t.sub);
  $('shipAmt').textContent = t.ship ? rs(t.ship) : 'FREE';
  $('totalAmt').textContent = rs(t.total);
  const { freeAbove, shipping } = state.settings;
  $('freeShipNote').textContent = shipping && freeAbove && t.sub < freeAbove ? `₹${(freeAbove - t.sub).toLocaleString('en-IN')} aur ki shopping par FREE delivery!` : '';
  $('cartSummaryBox').style.display = 'block';
}

function openCart(step = 1) {
  $('cartSidebar').classList.add('open');
  $('cartOverlay').classList.add('open');
  goStep(step);
}
function closeCart() {
  $('cartSidebar').classList.remove('open');
  $('cartOverlay').classList.remove('open');
}

// =====================================================================
// CHECKOUT STEPS
// =====================================================================
function goStep(n) {
  if (n > 1 && !cartLines().length) n = 1;
  if (n >= 3 && !state.user) n = 2;
  if (n === 2 && state.user) n = 3;
  if (n === 4 && !state.address) n = 3;
  state.step = n;
  document.querySelectorAll('.cart-step').forEach((s) => s.classList.remove('active'));
  $('step' + n).classList.add('active');
  $('cartTitle').textContent = { 1: '🛒 My Cart', 2: '📱 Login', 3: '📍 Address', 4: '💳 Payment' }[n];
  $('stepBar').style.display = n > 1 ? 'flex' : 'none';
  for (let i = 1; i <= 4; i++) $('sdot' + i).className = 'step-dot' + (i < n ? ' done' : i === n ? ' active' : '');
  for (let i = 1; i <= 3; i++) $('sline' + i).className = 'step-line' + (i < n ? ' done' : '');
  if (n === 1) renderCart();
  if (n === 2) renderLogin($('checkoutLogin'), 'Order karne ke liye login karein');
  if (n === 3) renderAddressStep();
  if (n === 4) renderPayment();
}

// ---------- address ----------
function readAddressForm() {
  const v = (id) => $(id).value.trim();
  return { name: v('custName'), phone: v('custPhone').replace(/\D/g, '').slice(-10), line1: v('custAddr1'), line2: v('custAddr2'),
    landmark: v('custLandmark'), city: v('custCity'), state: v('custState'), pincode: v('custPincode'), altPhone: v('custAltPhone') };
}
function addressError(a) {
  if (!a.name || a.name.length < 2) return 'Naam likhein';
  if (!/^[6-9]\d{9}$/.test(a.phone)) return 'Sahi 10-digit mobile number likhein';
  if (!a.line1 || a.line1.length < 3) return 'House / Street likhein';
  if (!a.city) return 'City likhein';
  if (!a.state) return 'State likhein';
  if (!/^[1-9]\d{5}$/.test(a.pincode)) return 'Sahi 6-digit pincode likhein';
  return '';
}
function addressText(a) {
  return [a.line1, a.line2, a.landmark, a.city, a.state].filter(Boolean).join(', ') + ' - ' + a.pincode;
}
let selectedAddressIndex = -1;
function renderAddressStep() {
  const saved = (state.profile && state.profile.addresses) || [];
  if (selectedAddressIndex >= saved.length) selectedAddressIndex = -1;
  if (selectedAddressIndex === -1 && saved.length && !$('custName').value) selectedAddressIndex = 0;
  $('savedAddresses').innerHTML = saved.length ? saved.map((a, i) => `
    <label class="addr-card ${selectedAddressIndex === i ? 'selected' : ''}">
      <input type="radio" name="addrPick" value="${i}" ${selectedAddressIndex === i ? 'checked' : ''}>
      <span><b>${esc(a.name)}</b> · ${esc(a.phone)}<br>${esc(addressText(a))}</span></label>`).join('')
    + `<label class="addr-card ${selectedAddressIndex === -1 ? 'selected' : ''}"><input type="radio" name="addrPick" value="-1" ${selectedAddressIndex === -1 ? 'checked' : ''}><span>➕ Naya address</span></label>` : '';
  $('addressForm').style.display = selectedAddressIndex === -1 ? 'block' : 'none';
  if (selectedAddressIndex === -1 && !$('custPhone').value && state.user && state.user.phoneNumber) {
    $('custPhone').value = state.user.phoneNumber.replace(/^\+91/, '');
  }
  if (selectedAddressIndex === -1 && !$('custName').value && state.profile && state.profile.name) $('custName').value = state.profile.name;
  $('addrErr').textContent = '';
}
async function toPayment() {
  const saved = (state.profile && state.profile.addresses) || [];
  let a;
  if (selectedAddressIndex >= 0 && saved[selectedAddressIndex]) a = saved[selectedAddressIndex];
  else {
    a = readAddressForm();
    const err = addressError(a);
    if (err) { $('addrErr').textContent = '❌ ' + err; return; }
    if ($('saveAddress').checked) await saveAddressToProfile(a);
  }
  state.address = a;
  goStep(4);
}
async function saveAddressToProfile(a) {
  if (!state.user) return;
  const list = ((state.profile && state.profile.addresses) || []).filter((x) => addressText(x) !== addressText(a) || x.phone !== a.phone);
  list.unshift(a);
  try {
    await db.collection('users').doc(state.user.uid).set({
      addresses: list.slice(0, 10), ...(state.profile && state.profile.name ? {} : { name: a.name }), updatedAt: Date.now(),
    }, { merge: true });
    selectedAddressIndex = 0;
  } catch (e) { console.error('Address save', e); }
}

// ---------- payment ----------
function codBlockers() { return cartLines().filter((l) => !l.p.cod).map((l) => l.p.name); }
function renderPayment() {
  const lines = cartLines().map((l) => ({ price: l.p.price, qty: l.qty }));
  const s = state.settings;
  const blockers = codBlockers();
  const codOk = s.codEnabled && !blockers.length;
  $('pmCOD').style.display = s.codEnabled ? '' : 'none';
  $('pmCOD').disabled = !codOk;
  $('codBlockedNote').style.display = s.codEnabled && blockers.length ? 'block' : 'none';
  $('codBlockedNote').innerHTML = blockers.length ? `🚫 In products par COD nahi hai: <b>${blockers.map(esc).join(', ')}</b>` : '';
  if (state.payMethod === 'cod' && !codOk) state.payMethod = '';
  const codT = calcTotals(lines, s, 'cod');
  $('codSmall').textContent = codOk ? (codT.advance ? `${rs(codT.advance)} advance` : 'Poora delivery pe') : '';
  document.querySelectorAll('[data-pay]').forEach((b) => b.classList.toggle('selected', b.dataset.pay === state.payMethod));

  const t = calcTotals(lines, s, state.payMethod === 'cod' ? 'cod' : 'prepaid');
  let html = `<div class="sum-row"><span>Subtotal</span><span>${rs(t.sub)}</span></div>
    <div class="sum-row"><span>🚚 Shipping</span><span>${t.ship ? rs(t.ship) : 'FREE'}</span></div>`;
  if (t.codCharge) html += `<div class="sum-row"><span>💵 COD charge</span><span>${rs(t.codCharge)}</span></div>`;
  html += `<div class="sum-row total"><span>Total</span><span>${rs(t.total)}</span></div>`;
  if (state.payMethod === 'cod') {
    if (t.advance) html += `<div class="sum-row adv"><span>Abhi online advance</span><span>${rs(t.advance)}</span></div>`;
    html += `<div class="sum-row bal"><span>Delivery pe cash</span><span>${rs(t.balance)}</span></div>`;
  }
  $('payBreakdown').innerHTML = html;
  const a = state.address;
  $('shipTo').innerHTML = a ? `📍 <b>${esc(a.name)}</b> · ${esc(a.phone)}<br>${esc(addressText(a))} <button type="button" class="link-like" data-step="3">Badlo</button>` : '';
  const btn = $('placeOrderBtn');
  btn.disabled = !state.payMethod || state.placing;
  btn.textContent = state.placing ? '⏳ Please wait...'
    : !state.payMethod ? 'Payment method chunein'
      : state.payMethod === 'razorpay' ? `🔒 Pay ${rs(t.total)}`
        : t.advance ? `🔒 ${rs(t.advance)} advance pay karein` : '✅ Place COD Order';
  $('payErr').textContent = '';
}

// Test mode only: a stand-in for Razorpay that signs with the local test secret
function fakeRazorpay() {
  window.Razorpay = function (o) { this.o = o; };
  window.Razorpay.prototype.on = function () {};
  window.Razorpay.prototype.open = async function () {
    if (!confirm(`🧪 TEST PAYMENT\n\n${this.o.description}\nAmount: ₹${this.o.amount / 100}\n\nOK = payment successful, Cancel = payment cancel`)) return this.o.modal.ondismiss();
    const pid = 'pay_test_' + Date.now();
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('rzp_secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(this.o.order_id + '|' + pid));
    this.o.handler({ razorpay_order_id: this.o.order_id, razorpay_payment_id: pid,
      razorpay_signature: [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('') });
  };
}
function loadRazorpay() {
  if (HMI.emulator && !window.Razorpay) fakeRazorpay();
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Payment page load nahi hua. Internet check karein.'));
    document.head.appendChild(s);
  });
}

async function placeOrder() {
  if (state.placing || !state.payMethod) return;
  if (!cfg.workerUrl) {
    const lines = cartLines();
    const msg = 'Hello HMI Fashion! Mujhe yeh order karna hai:\n' + lines.map((l) => `▪️ ${l.p.name}${l.size ? ' [' + l.size + ']' : ''}${l.color ? ' [' + l.color + ']' : ''} x${l.qty}`).join('\n')
      + (state.address ? `\n\n📍 ${state.address.name}, ${state.address.phone}\n${addressText(state.address)}` : '');
    $('payErr').innerHTML = `Online order abhi shuru ho raha hai. <a href="https://wa.me/${WA}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">WhatsApp par order karein →</a>`;
    return;
  }
  state.placing = true; renderPayment();
  try {
    const items = state.cart.map((i) => ({ productId: i.productId, qty: i.qty, size: i.size, color: i.color }));
    const res = await HMI.callWorker('/checkout/start', { items, address: state.address, method: state.payMethod });
    if (res.placed) return orderPlaced(res.orderNo);
    await loadRazorpay();
    await new Promise((resolve) => {
      const rz = new window.Razorpay({
        key: res.razorpay.key, order_id: res.razorpay.orderId, amount: res.razorpay.amount, currency: 'INR',
        name: cfg.storeName, description: state.payMethod === 'cod' ? `COD advance — ${res.orderNo}` : `Order ${res.orderNo}`,
        prefill: { name: state.address.name, contact: '+91' + state.address.phone, email: (state.user && state.user.email) || '' },
        theme: { color: '#db2777' },
        handler: async (resp) => {
          try {
            const done = await HMI.callWorker('/checkout/confirm', resp);
            orderPlaced(done.orderNo);
          } catch (e) {
            $('payErr').textContent = '⚠️ Payment ho gaya par confirm karne mein dikkat aayi. Ghabraiye mat — order kuch der mein "My Orders" mein dikh jayega. Order no: ' + res.orderNo;
          }
          resolve();
        },
        modal: { ondismiss: () => { $('payErr').textContent = 'Payment poora nahi hua. Dobara try kar sakte hain.'; resolve(); } },
      });
      rz.on('payment.failed', (r) => { $('payErr').textContent = '❌ Payment fail: ' + ((r.error && r.error.description) || 'dobara try karein'); });
      rz.open();
    });
  } catch (e) {
    $('payErr').textContent = '❌ ' + e.message;
  } finally {
    state.placing = false;
    if (state.step === 4) { const err = $('payErr').innerHTML; renderPayment(); $('payErr').innerHTML = err; }
  }
}

function orderPlaced(orderNo) {
  state.cart = []; saveCart(); renderCart();
  state.payMethod = ''; state.address = null;
  closeCart();
  $('orderNoDisplay').textContent = orderNo;
  $('successWaBtn').href = `https://wa.me/${WA}?text=${encodeURIComponent(`Hello HMI Fashion! Maine order ${orderNo} place kiya hai.`)}`;
  $('successOverlay').classList.add('open');
}

// =====================================================================
// LOGIN (Phone OTP + Google) — used in checkout and in My Account
// =====================================================================
let recaptcha = null, confirmation = null;
function friendlyAuth(e) {
  const map = {
    'auth/invalid-phone-number': 'Mobile number sahi nahi hai.',
    'auth/invalid-verification-code': 'OTP galat hai. Dobara check karein.',
    'auth/code-expired': 'OTP purana ho gaya. Naya OTP mangwayein.',
    'auth/too-many-requests': 'Bahut zyada koshish. Thodi der baad try karein.',
    'auth/popup-closed-by-user': 'Google window band ho gayi.',
    'auth/popup-blocked': 'Popup block ho gaya. Browser mein popup allow karein.',
    'auth/network-request-failed': 'Internet check karein.',
    'auth/billing-not-enabled': 'SMS OTP abhi chalu nahi hai. Google se login karein.',
    'auth/operation-not-allowed': 'Yeh login tareeka abhi chalu nahi hai.',
  };
  return map[e.code] || e.message;
}
function renderLogin(box, subtitle) {
  box.innerHTML = `
    <div class="login-box">
      <div class="otp-icon">📱</div>
      <div class="otp-title">Login karein</div>
      <div class="otp-sub">${esc(subtitle || 'Apne orders aur wishlist ke liye login karein')}</div>
      <div data-phase="phone">
        <div class="phone-row"><span class="cc">+91</span>
          <input class="field-input" data-el="phone" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit mobile number" autocomplete="tel-national"></div>
        <button class="cart-footer-btn btn-proceed" type="button" data-act="send">📲 OTP bhejo</button>
      </div>
      <div data-phase="otp" style="display:none">
        <div class="otp-sub">OTP bheja gaya: <b data-el="sentTo"></b></div>
        <input class="field-input otp-input" data-el="code" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="one-time-code">
        <button class="cart-footer-btn btn-proceed" type="button" data-act="verify">✅ Verify OTP</button>
        <button class="link-like" type="button" data-act="change" style="margin-top:10px">Number badlo</button>
      </div>
      <div class="form-err" data-el="err"></div>
      <div class="or-line">ya</div>
      <button class="google-btn" type="button" data-act="google"><img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" width="18" height="18" alt=""> Google se login</button>
    </div>`;
  const q = (s) => box.querySelector(s);
  const err = (m) => { q('[data-el=err]').textContent = m ? '❌ ' + m : ''; };
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

  q('[data-act=send]').addEventListener('click', async (ev) => {
    const phone = q('[data-el=phone]').value.replace(/\D/g, '');
    if (!/^[6-9]\d{9}$/.test(phone)) return err('Sahi 10-digit mobile number likhein');
    err(''); busy(ev.target, true, '⏳ Bhej rahe hain...');
    try {
      if (!recaptcha) recaptcha = new firebase.auth.RecaptchaVerifier('recaptcha-container', { size: 'invisible' });
      confirmation = await auth.signInWithPhoneNumber('+91' + phone, recaptcha);
      q('[data-phase=phone]').style.display = 'none';
      q('[data-phase=otp]').style.display = 'block';
      q('[data-el=sentTo]').textContent = '+91 ' + phone;
      q('[data-el=code]').focus();
      if (HMI.emulator) { // test mode: show the OTP instead of sending an SMS
        const r = await fetch(`${HMI.emulatorAuthUrl}/emulator/v1/projects/${cfg.firebase.projectId}/verificationCodes`).then((x) => x.json());
        const c = (r.verificationCodes || []).filter((v) => v.phoneNumber === '+91' + phone).pop();
        if (c) q('[data-el=sentTo]').textContent += ` — 🧪 Test OTP: ${c.code}`;
      }
    } catch (e) {
      err(friendlyAuth(e));
      try { recaptcha && recaptcha.clear(); } catch { /* already cleared */ }
      recaptcha = null;
    } finally { busy(ev.target, false, '📲 OTP bhejo'); }
  });
  const verify = async (btn) => {
    const code = q('[data-el=code]').value.replace(/\D/g, '');
    if (code.length !== 6) return err('6-digit OTP likhein');
    err(''); busy(btn, true, '⏳ Check ho raha hai...');
    try { await confirmation.confirm(code); } catch (e) { err(friendlyAuth(e)); } finally { busy(btn, false, '✅ Verify OTP'); }
  };
  q('[data-act=verify]').addEventListener('click', (ev) => verify(ev.target));
  q('[data-el=code]').addEventListener('input', (ev) => { if (ev.target.value.replace(/\D/g, '').length === 6) verify(q('[data-act=verify]')); });
  q('[data-act=change]').addEventListener('click', () => {
    q('[data-phase=phone]').style.display = 'block'; q('[data-phase=otp]').style.display = 'none'; err('');
  });
  q('[data-act=google]').addEventListener('click', async () => {
    err('');
    try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); } catch (e) { err(friendlyAuth(e)); }
  });
}

// =====================================================================
// ACCOUNT: profile, wishlist, orders
// =====================================================================
auth.onAuthStateChanged(async (user) => {
  state.user = user;
  if (state.profileUnsub) { state.profileUnsub(); state.profileUnsub = null; }
  if (state.ordersUnsub) { state.ordersUnsub(); state.ordersUnsub = null; }
  state.profile = null; state.orders = [];
  $('accountBtn').textContent = user ? '😊' : '👤';
  if (!user) { loadLocalWishlist(); renderAccount(); return; }

  const ref = db.collection('users').doc(user.uid);
  try {
    const snap = await ref.get();
    const localWish = [...state.wishlist];
    if (!snap.exists) {
      await ref.set({
        name: user.displayName || '', email: user.email || '', phone: user.phoneNumber || '',
        addresses: [], wishlist: localWish.slice(0, 200), createdAt: Date.now(), updatedAt: Date.now(),
      });
    } else if (localWish.length) {
      const merged = [...new Set([...(snap.data().wishlist || []), ...localWish])].slice(0, 200);
      await ref.update({ wishlist: merged, updatedAt: Date.now() });
    }
    localStorage.removeItem('hmi_wishlist');
  } catch (e) { console.error('Profile', e); }

  state.profileUnsub = ref.onSnapshot((d) => {
    state.profile = d.exists ? d.data() : null;
    state.wishlist = new Set((state.profile && state.profile.wishlist) || []);
    renderWishState();
    if (state.step === 3) renderAddressStep();
    renderAccount();
  }, (e) => console.error('Profile listen', e));

  state.ordersUnsub = db.collection('orders').where('userId', '==', user.uid).onSnapshot((snap) => {
    state.orders = snap.docs.map((d) => normalizeOrder(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
    renderAccount();
  }, (e) => console.error('Orders listen', e));

  if (state.step === 2 && $('cartSidebar').classList.contains('open')) goStep(3);
  if ($('accountOverlay').classList.contains('open')) renderAccount();
});

function loadLocalWishlist() {
  try { state.wishlist = new Set(JSON.parse(localStorage.getItem('hmi_wishlist') || '[]')); } catch { state.wishlist = new Set(); }
  renderWishState();
}
async function toggleWish(id) {
  const on = !state.wishlist.has(id);
  if (on) state.wishlist.add(id); else state.wishlist.delete(id);
  renderWishState();
  flash(on ? '♥ Wishlist mein add' : 'Wishlist se hataya', on ? '' : '#6b7280');
  if (state.user) {
    try {
      await db.collection('users').doc(state.user.uid).update({
        wishlist: on ? firebase.firestore.FieldValue.arrayUnion(id) : firebase.firestore.FieldValue.arrayRemove(id), updatedAt: Date.now(),
      });
    } catch (e) { console.error('Wishlist', e); }
  } else {
    localStorage.setItem('hmi_wishlist', JSON.stringify([...state.wishlist]));
  }
}
function renderWishState() {
  const n = [...state.wishlist].filter((id) => findProduct(id)).length;
  $('wishCount').textContent = n;
  $('wishCount').style.display = n ? 'flex' : 'none';
  document.querySelectorAll('[data-wish]').forEach((b) => {
    const on = state.wishlist.has(b.dataset.wish);
    b.classList.toggle('on', on); b.textContent = on ? '♥' : '♡';
  });
  renderPdpWish();
  if ($('accountOverlay').classList.contains('open') && state.accountTab === 'wishlist') renderAccount();
}

function openAccount(tab) {
  state.accountTab = tab || state.accountTab;
  $('accountOverlay').classList.add('open');
  lockScroll(true);
  renderAccount();
}
function closeAccount() { $('accountOverlay').classList.remove('open'); lockScroll(false); }

function renderAccount() {
  if (!$('accountOverlay').classList.contains('open')) return;
  const body = $('accountBody');
  const tab = state.accountTab;
  // Wishlist works without login
  if (!state.user && tab !== 'wishlist') {
    $('accTabs').style.display = 'none';
    $('accountSub').textContent = 'Login karke apne orders dekhein';
    renderLogin(body, 'Orders, address aur wishlist ke liye login karein');
    return;
  }
  $('accTabs').style.display = state.user ? 'flex' : 'none';
  $('accountSub').textContent = state.user ? (state.profile && state.profile.name) || state.user.phoneNumber || state.user.email || 'My Account' : 'Wishlist';
  document.querySelectorAll('#accTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'orders') body.innerHTML = renderOrdersTab();
  if (tab === 'wishlist') body.innerHTML = renderWishlistTab();
  if (tab === 'addresses') body.innerHTML = renderAddressesTab();
  if (tab === 'profile') body.innerHTML = renderProfileTab();
}

function renderOrdersTab() {
  if (!state.orders.length) return '<div class="empty-msg"><div class="big">📦</div>Abhi koi order nahi.<br><button type="button" class="mini-btn" data-close-account style="margin-top:12px">🛍️ Shopping karein</button></div>';
  return state.orders.map((o) => {
    const cur = HMI.STATUS.indexOf(o.status);
    const steps = o.status === 'Cancelled'
      ? '<div class="cancelled-box" style="margin:8px 0;">❌ Yeh order cancel ho gaya.' + (o.payment.refundDue ? ` ${rs(o.payment.refundDue)} ka refund 5-7 din mein aayega.` : '') + '</div>'
      : `<div class="track-timeline" style="margin:10px 0;">${HMI.STATUS.map((s, i) => `
          <div class="track-step ${i <= cur ? 'done' : 'inactive'}"><div class="track-icon">${i <= cur ? HMI.STATUS_ICON[s] : '○'}</div>
          <div class="track-info"><h4>${{ Pending: 'Order Placed', Confirmed: 'Confirmed', Shipped: 'Shipped', Delivered: 'Delivered' }[s]}</h4>
          <p>${o.statusTimes[s] ? fmtDate(o.statusTimes[s]) : 'Abhi nahi'}</p></div></div>`).join('')}</div>`;
    const trk = o.tracking && (o.tracking.id || o.tracking.courier)
      ? `<div class="ship-to" style="margin:6px 0;">🚚 ${esc(o.tracking.courier || 'Courier')} ${o.tracking.id ? '· AWB <b>' + esc(o.tracking.id) + '</b>' : ''}
         ${o.tracking.url && safeUrl(o.tracking.url) ? ` · <a href="${safeUrl(o.tracking.url)}" target="_blank" rel="noopener">Track karein →</a>` : ''}</div>` : '';
    return `<div class="order-card">
      <div class="order-card-head"><div><b>${esc(o.orderNo)}</b><br><span style="font-size:.72rem;color:var(--gray)">${fmtDate(o.createdAt)}</span></div>
        <span class="ostatus ${esc(o.status)}">${HMI.STATUS_ICON[o.status] || ''} ${esc(o.status)}</span></div>
      ${o.items.map((i) => `<div class="order-line">${i.image && safeUrl(i.image) ? `<img src="${safeUrl(i.image)}" alt="">` : `<span class="oemoji">${esc(i.emoji)}</span>`}
        <span style="flex:1">${esc(i.name)}${i.size ? ' · ' + esc(i.size) : ''}${i.color ? ' · ' + esc(i.color) : ''} × ${i.qty}</span><b>${rs(i.price * i.qty)}</b></div>`).join('')}
      <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-top:6px;"><span>${esc(payLabel(o.payment))}</span><b>Total ${rs(o.total)}</b></div>
      ${o.payment.method === 'cod' && o.payment.balance && o.status !== 'Cancelled' ? `<div style="font-size:.78rem;color:#16a34a;font-weight:700;">Delivery pe ${rs(o.payment.balance)} cash dena hai</div>` : ''}
      ${trk}${steps}
      <div class="order-actions">
        ${o.status === 'Pending' ? `<button type="button" class="mini-btn danger" data-cancel="${esc(o.orderNo)}">✖ Cancel order</button>` : ''}
        <a class="mini-btn wa" target="_blank" rel="noopener" href="https://wa.me/${WA}?text=${encodeURIComponent('Hello HMI Fashion! Mere order ' + o.orderNo + ' ke baare mein baat karni hai.')}">💬 Help</a>
      </div></div>`;
  }).join('');
}
function renderWishlistTab() {
  const list = [...state.wishlist].map(findProduct).filter(Boolean);
  if (!list.length) return '<div class="empty-msg"><div class="big">♡</div>Wishlist khali hai.<br>Products par ♡ dabakar save karein.</div>';
  return (state.user ? '' : '<div class="ship-to" style="margin-bottom:10px;">💡 Login karein toh wishlist har device par milegi.</div>')
    + list.map((p) => `<div class="order-card" style="display:flex;gap:12px;align-items:center;">
      <div style="width:60px;height:60px;border-radius:10px;overflow:hidden;background:${esc(p.bg)};display:flex;align-items:center;justify-content:center;font-size:2rem;flex-shrink:0;">${imgOrEmoji(p, '', 'width:100%;height:100%;object-fit:cover;')}</div>
      <div style="flex:1;"><b>${esc(p.name)}</b><br><span style="color:var(--pink-deep);font-weight:800;">${rs(p.price)}</span> ${outOfStock(p) ? '<span class="qty-badge qty-out">Out of Stock</span>' : ''}</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button type="button" class="mini-btn" data-pdp="${esc(p.id)}" data-close-account>👁️ Dekho</button>
        <button type="button" class="mini-btn danger" data-wish="${esc(p.id)}">✖ Hatao</button></div></div>`).join('');
}
function renderAddressesTab() {
  const list = (state.profile && state.profile.addresses) || [];
  if (!list.length) return '<div class="empty-msg"><div class="big">📍</div>Koi saved address nahi.<br>Checkout ke waqt address save ho jayega.</div>';
  return list.map((a, i) => `<div class="addr-card" style="cursor:default"><span><b>${esc(a.name)}</b> · ${esc(a.phone)}<br>${esc(addressText(a))}</span>
    <button type="button" class="addr-del" data-del-addr="${i}" aria-label="Delete">🗑️</button></div>`).join('');
}
function renderProfileTab() {
  const p = state.profile || {};
  return `<label class="check-line" style="display:block;font-weight:700;">Naam</label>
    <input class="field-input" id="profName" value="${esc(p.name || '')}" maxlength="100" placeholder="Aapka naam">
    <div class="ship-to" style="margin-bottom:12px;">📱 ${esc(state.user.phoneNumber || p.phone || '—')}<br>📧 ${esc(state.user.email || p.email || '—')}</div>
    <button type="button" class="cart-footer-btn btn-proceed" id="profSave">💾 Save</button>
    <button type="button" class="cart-footer-btn btn-back" id="logoutBtn">🚪 Logout</button>`;
}

async function cancelMyOrder(orderNo) {
  if (!confirm(`Order ${orderNo} cancel karein?`)) return;
  try {
    const r = await HMI.callWorker('/orders/cancel', { orderNo });
    flash(r.refundDue ? `Order cancel. ${rs(r.refundDue)} refund 5-7 din mein.` : 'Order cancel ho gaya');
  } catch (e) { flash('❌ ' + e.message, '#dc2626'); }
}

// =====================================================================
// EVENTS
// =====================================================================
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-wish],[data-add],[data-pdp],[data-cat],[data-account],[data-step],[data-pay],[data-qty],[data-remove],[data-cancel],[data-del-addr],[data-tab],[data-thumb],[data-size],[data-color],[data-close-account]');
  if (!t) return;
  if (t.dataset.wish !== undefined) { e.stopPropagation(); toggleWish(t.dataset.wish); return; }
  if (t.dataset.add !== undefined) { e.stopPropagation(); quickAdd(t.dataset.add); return; }
  if (t.dataset.closeAccount !== undefined) closeAccount();
  if (t.dataset.pdp !== undefined) { openPDP(t.dataset.pdp); return; }
  if (t.dataset.cat !== undefined) {
    state.activeCat = t.dataset.cat; state.search = ''; $('searchInput').value = '';
    renderCategories(); renderProducts();
    if (t.dataset.cat !== 'all') $('products').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (t.dataset.account !== undefined) { e.preventDefault(); $('navMenu').classList.remove('open'); openAccount(t.dataset.account); return; }
  if (t.dataset.step !== undefined) { goStep(Number(t.dataset.step)); return; }
  if (t.dataset.pay !== undefined) { if (!t.disabled) { state.payMethod = t.dataset.pay; renderPayment(); } return; }
  if (t.dataset.qty !== undefined) { changeQty(Number(t.dataset.qty), Number(t.dataset.d)); return; }
  if (t.dataset.remove !== undefined) { state.cart.splice(Number(t.dataset.remove), 1); saveCart(); renderCart(); return; }
  if (t.dataset.cancel !== undefined) { cancelMyOrder(t.dataset.cancel); return; }
  if (t.dataset.delAddr !== undefined) {
    const list = [...((state.profile && state.profile.addresses) || [])];
    list.splice(Number(t.dataset.delAddr), 1);
    db.collection('users').doc(state.user.uid).update({ addresses: list, updatedAt: Date.now() }).catch((err) => flash('❌ ' + err.message, '#dc2626'));
    return;
  }
  if (t.dataset.tab !== undefined) { state.accountTab = t.dataset.tab; renderAccount(); return; }
  if (t.dataset.thumb !== undefined) {
    $('pdpActiveImg').src = t.src;
    document.querySelectorAll('.pdp-thumb').forEach((x) => x.classList.toggle('active', x === t));
    return;
  }
  if (t.dataset.size !== undefined) {
    pdp.size = t.dataset.size; $('pdpHint').textContent = '';
    document.querySelectorAll('#pdpSizes .size-btn').forEach((b) => b.classList.toggle('selected', b === t));
    return;
  }
  if (t.dataset.color !== undefined) {
    pdp.color = t.dataset.color; $('pdpHint').textContent = '';
    document.querySelectorAll('#pdpColors .color-dot').forEach((d) => d.classList.toggle('selected', d === t));
  }
});
document.addEventListener('change', (e) => {
  if (e.target.name === 'addrPick') { selectedAddressIndex = Number(e.target.value); renderAddressStep(); }
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'profSave') {
    const name = $('profName').value.trim().slice(0, 100);
    db.collection('users').doc(state.user.uid).update({ name, updatedAt: Date.now() })
      .then(() => flash('✅ Save ho gaya')).catch((err) => flash('❌ ' + err.message, '#dc2626'));
  }
  if (e.target.id === 'logoutBtn') { auth.signOut(); closeAccount(); flash('Logout ho gaye'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('pdpOverlay').classList.contains('open')) closePDP();
  else if ($('accountOverlay').classList.contains('open')) closeAccount();
  else if ($('cartSidebar').classList.contains('open')) closeCart();
});

$('cartBtn').addEventListener('click', () => openCart(1));
$('cartOverlay').addEventListener('click', closeCart);
$('cartClose').addEventListener('click', closeCart);
$('checkoutBtn').addEventListener('click', () => goStep(state.user ? 3 : 2));
$('toPaymentBtn').addEventListener('click', toPayment);
$('placeOrderBtn').addEventListener('click', placeOrder);
$('pdpClose').addEventListener('click', closePDP);
$('pdpOverlay').addEventListener('click', (e) => { if (e.target.id === 'pdpOverlay') closePDP(); });
$('pdpAddCart').addEventListener('click', pdpAdd);
$('pdpWish').addEventListener('click', () => pdp.p && toggleWish(pdp.p.id));
$('accountClose').addEventListener('click', closeAccount);
$('accountOverlay').addEventListener('click', (e) => { if (e.target.id === 'accountOverlay') closeAccount(); });
$('successCloseBtn').addEventListener('click', () => $('successOverlay').classList.remove('open'));
$('successOrdersBtn').addEventListener('click', () => { $('successOverlay').classList.remove('open'); openAccount('orders'); });
$('shopClear').addEventListener('click', () => { state.activeCat = 'all'; state.search = ''; $('searchInput').value = ''; renderCategories(); renderProducts(); });
let searchTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value; renderProducts(); }, 200);
});
$('sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; renderProducts(); });
document.querySelectorAll('#navMenu a[href^="#"]').forEach((a) => a.addEventListener('click', () => $('navMenu').classList.remove('open')));

// =====================================================================
// START
// =====================================================================
state.cart = loadCart();
saveCart();
loadLocalWishlist();
renderShipTexts();
renderCart();
startCatalogue();
