// HMI Fashion Store — customer storefront
// Catalogue + account data come from Firestore; orders are placed through the
// checkout worker (it prices the cart and verifies Razorpay payments).
const { db, auth, esc, safeUrl, rs, fmtDate, normalizeProduct, normalizeOrder, payLabel, cfg } = HMI;
const { calcTotals, paySettings: readPay } = HMI.pricing;
const $ = (id) => document.getElementById(id);
const WA = cfg.whatsapp;

const state = {
  products: [], categories: [], settings: readPay(), home: { heroImage: '', newArrivals: [] },
  user: null, profile: null,
  cart: [], wishlist: new Set(),
  activeCat: 'all', search: '', sort: 'new',
  step: 1, address: null, payMethod: '', placing: false,
  accountTab: 'orders', accAddrEdit: null, orders: [], ordersUnsub: null, profileUnsub: null,
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

  db.collection('settings').doc('home').onSnapshot((d) => {
    const h = (d.exists && d.data()) || {};
    state.home = {
      heroImage: typeof h.heroImage === 'string' ? h.heroImage : '',
      newArrivals: Array.isArray(h.newArrivals) ? h.newArrivals.map(String) : [],
    };
    renderHeroImage(); renderHeroProducts();
  }, (e) => console.error('Homepage settings', e));

  db.collection('settings').doc('payment').onSnapshot((d) => {
    state.settings = readPay(d.exists ? d.data() : null);
    renderShipTexts(); renderCart();
    if (state.step === 4) renderPayment();
  }, (e) => console.error('Settings', e));
}

function renderCatalogue() {
  renderCategories(); renderProducts();
  renderHeroImage(); renderHeroProducts();
}

function renderShipTexts() {
  const { shipping, freeAbove } = state.settings;
  $('heroShip').textContent = shipping === 0 ? 'Free Pan India delivery'
    : freeAbove ? `Free delivery above ₹${freeAbove.toLocaleString('en-IN')}` : `Pan India delivery ₹${shipping}`;
  $('whyShipTitle').textContent = shipping ? 'Delivery @ ₹' + shipping : 'Free Delivery';
  $('whyShipText').textContent = freeAbove && shipping ? `FREE delivery above ₹${freeAbove.toLocaleString('en-IN')}` : 'Fast & safe Pan India delivery';
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
  const card = (id, icon, name, sub) => {
    const product = state.products.find((p) => (id === 'all' || productInCat(p, id)) && p.images[0] && safeUrl(p.images[0]));
    const src = product && safeUrl(product.images[0]);
    return `
    <div class="category-card ${state.activeCat === id ? 'active' : ''}" data-cat="${esc(id)}" role="button" tabindex="0">
      ${src ? `<img class="category-photo" src="${src}" alt="" loading="lazy">` : ''}
      <div class="category-fallback" ${src ? 'hidden' : ''}>${esc(icon)}</div>
      <div class="category-label"><h3>${esc(name)}</h3></div></div>`;
  };
  grid.innerHTML = card('all', '🛍️', 'All Items', 'Full Collection')
    + state.categories.map((c) => card(c.id, c.icon || '🏷️', c.name, c.sub)).join('');
  grid.querySelectorAll('.category-photo').forEach((img) => {
    img.addEventListener('error', () => {
      img.hidden = true;
      img.nextElementSibling.hidden = false;
    }, { once: true });
  });
}

// Hero: brand banner on the left, "New arrivals" on the right. Both can be set in
// admin → Homepage (settings/home); otherwise config heroImage + the newest products.
function heroSrc() {
  const h = state.home.heroImage;
  if (h === 'none') return '';
  if (h) return safeUrl(h) ? h : '';
  return cfg.heroImage || '';
}
function renderHeroImage() {
  const img = $('heroBrandImg'), src = heroSrc();
  if ((img.dataset.src || '') === src) return;
  img.dataset.src = src;
  if (!src) { img.hidden = true; img.removeAttribute('src'); $('heroBrand').classList.remove('has-photo'); return; }
  img.onload = () => { img.hidden = false; $('heroBrand').classList.add('has-photo'); };
  img.onerror = () => { img.hidden = true; $('heroBrand').classList.remove('has-photo'); };
  img.src = src;
}
function renderHeroProducts() {
  const grid = $('heroProducts');
  if (!state.catalogueReady && !state.products.length) return;
  const chosen = state.home.newArrivals.map(findProduct).filter(Boolean);
  const picks = chosen.length ? chosen.slice(0, 4) : [...state.products]
    .sort((a, b) => Number(outOfStock(a)) - Number(outOfStock(b)) || (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 4);
  const cards = picks.map((p) => {
    const src = p.images[0] && safeUrl(p.images[0]);
    return `
    <div class="hero2-card" data-pdp="${esc(p.id)}" role="button" tabindex="0">
      ${p.badge ? `<span class="hero2-tag">${esc(p.badge)}</span>` : ''}
      <div class="hero2-card-img" style="${src ? '' : `background:${esc(p.bg)}`}">${cardGallery(p, src ? `<img src="${src}" alt="${esc(p.name)}" loading="lazy">` : esc(p.emoji))}</div>
      <div class="hero2-card-info">
        <h3>${esc(p.name)}</h3>
        <div class="hero2-price">${rs(p.price)}${hasMrp(p) ? `<s>${rs(p.mrp)}</s><small>${offPct(p)}% off</small>` : ''}</div>
      </div>
    </div>`;
  });
  if (cards.length < 4) cards.push('<a class="hero2-more" href="#products"><b>The full collection</b><span>Shop now →</span></a>');
  grid.dataset.count = cards.length;
  grid.innerHTML = cards.join('');
  initGalleries(grid);
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
  if (p.stock <= 5) return `<span class="qty-badge qty-low">Only ${p.stock} left!</span>`;
  return '<span class="qty-badge qty-instock">In Stock</span>';
}

function renderProducts() {
  const list = visibleProducts();
  const grid = $('productsGrid');
  const isAll = state.activeCat === 'all' && !state.search;
  $('shopTitle').textContent = state.search ? `Results for "${state.search}"` : state.activeCat === 'all' ? 'New Arrivals' : catName(state.activeCat);
  $('shopCount').textContent = list.length + (list.length === 1 ? ' product' : ' products');
  $('shopClear').style.display = isAll ? 'none' : 'inline-flex';
  if (!state.catalogueReady && !state.products.length) return;
  if (!list.length) {
    grid.innerHTML = `<div class="empty-grid"><div style="font-size:3rem;margin-bottom:12px">🛍️</div><p>${state.search ? 'No results found. Try another word.' : 'No products in this category yet.'}</p></div>`;
    return;
  }
  grid.innerHTML = list.map((p) => {
    const oos = outOfStock(p), wished = state.wishlist.has(p.id);
    return `
    <div class="product-card" data-pdp="${esc(p.id)}" style="cursor:pointer;">
      <div class="product-img" style="background:${esc(p.bg)}">
        ${cardGallery(p, imgOrEmoji(p, '', 'width:100%;height:100%;object-fit:cover;'))}
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
  initGalleries(grid);
}

// =====================================================================
// CARD GALLERY: products with several photos show dots on the card; the photo
// changes by itself, and with a swipe, a tap on a dot, or a press-and-hold
// =====================================================================
function cardGallery(p, fallback) {
  const imgs = p.images.map((u) => safeUrl(u)).filter(Boolean).slice(0, 8);
  if (imgs.length < 2) return fallback;
  return `<div class="pc-gallery" data-gallery>
    <div class="pc-track">${imgs.map((src, i) => `<img src="${src}" alt="${esc(p.name)}" loading="${i ? 'lazy' : 'eager'}" draggable="false">`).join('')}</div>
    <div class="pc-dots">${imgs.map((_, i) => `<button type="button" class="${i ? '' : 'on'}" data-dot="${i}" aria-label="Photo ${i + 1} of ${imgs.length}"></button>`).join('')}</div>
  </div>`;
}
const galleryAuto = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const visibleGalleries = new Set();
const galleryObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => entries.forEach((en) => (en.isIntersecting ? visibleGalleries.add(en.target) : visibleGalleries.delete(en.target))), { threshold: 0.6 })
  : null;
function initGalleries(root) {
  root.querySelectorAll('[data-gallery]').forEach((g) => {
    if (g.go) return;
    const track = g.querySelector('.pc-track'), dots = [...g.querySelectorAll('[data-dot]')];
    let idx = 0, holdTimer = null;
    const later = (ms) => { g.nextAt = Date.now() + ms + Math.random() * 1500; };
    g.go = (i) => { i = (i + dots.length) % dots.length; track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' }); later(3500); };
    track.addEventListener('scroll', () => {
      clearTimeout(holdTimer);
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i !== idx) { idx = i; dots.forEach((d, k) => d.classList.toggle('on', k === i)); }
      later(4000);
    }, { passive: true });
    // press and hold = next photo (and the tap that ends it does not open the product)
    g.addEventListener('pointerdown', () => { clearTimeout(holdTimer); holdTimer = setTimeout(() => { g.held = true; g.go(idx + 1); }, 450); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => g.addEventListener(ev, () => clearTimeout(holdTimer)));
    g.addEventListener('click', (e) => { if (g.held) { g.held = false; e.stopPropagation(); e.preventDefault(); } }, true);
    g.addEventListener('contextmenu', (e) => e.preventDefault());
    g.idx = () => idx;
    later(2500);
    if (galleryObserver) galleryObserver.observe(g); else visibleGalleries.add(g);
  });
}
setInterval(() => {
  if (!galleryAuto || document.hidden) return;
  const now = Date.now();
  visibleGalleries.forEach((g) => {
    if (!g.isConnected) { visibleGalleries.delete(g); return; }
    if (now >= g.nextAt) g.go(g.idx() + 1);
  });
}, 1000);

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
      : p.stock <= 5 ? `<span class="pdp-qty-tag qty-low">Only ${p.stock} left!</span>` : '<span class="pdp-qty-tag qty-instock">In Stock</span>') : '');
  $('pdpDesc').textContent = p.desc || 'Premium quality product from HMI Fashion Store.';
  $('pdpCodTag').innerHTML = state.settings.codEnabled && p.cod
    ? '<span class="pdp-cod-tag yes">💵 Cash on Delivery available</span>'
    : '<span class="pdp-cod-tag no">💳 Online payment only</span>';
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
  $('pdpWaBtn').href = `https://wa.me/${WA}?text=${encodeURIComponent(`Hello HMI! I'd like to know more about *${p.name}* (${rs(p.price)}).`)}`;
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
  if (p.sizes.length && !pdp.size) { $('pdpHint').textContent = '⚠️ Please select a size'; return; }
  if (p.colors.length && !pdp.color) { $('pdpHint').textContent = '⚠️ Please select a colour'; return; }
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
  if (p.trackStock && qtyInCart(p.id) + 1 > p.stock) { flash(`Only ${p.stock} available`, '#dc2626'); return false; }
  const key = cartKey(p.id, size, color);
  const ex = state.cart.find((i) => cartKey(i.productId, i.size, i.color) === key);
  if (ex) { if (ex.qty >= 10) { flash('Max 10 per item', '#dc2626'); return false; } ex.qty++; }
  else state.cart.push({ productId: p.id, size: size || '', color: color || '', qty: 1 });
  saveCart(); renderCart();
  flash('✅ Added to cart!');
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
  if (d > 0 && p && p.trackStock && qtyInCart(p.id) + 1 > p.stock) return flash(`Only ${p.stock} available`, '#dc2626');
  if (d > 0 && item.qty >= 10) return flash('Max 10 per item', '#dc2626');
  item.qty += d;
  if (item.qty <= 0) state.cart.splice(index, 1);
  saveCart(); renderCart();
}
function syncCartWithProducts() {
  if (!state.catalogueReady) return;
  const before = state.cart.length;
  state.cart = state.cart.filter((i) => findProduct(i.productId));
  if (state.cart.length !== before) flash('An item in your cart is no longer available and was removed', '#92650a');
  saveCart(); renderCart();
}

function renderCart() {
  const lines = cartLines();
  const wrap = $('cartItemsWrap');
  if (!lines.length) {
    wrap.innerHTML = '<div class="empty-msg"><div class="big">🛍️</div>Your cart is empty.<br>Add something you love!</div>';
    $('cartSummaryBox').style.display = 'none';
    return;
  }
  wrap.innerHTML = state.cart.map((l, i) => {
    const p = findProduct(l.productId);
    if (!p) return '';
    const src = p.images[0] && safeUrl(p.images[0]);
    const short = p.trackStock && p.stock < qtyInCart(p.id);
    return `<div class="cart-item">
      ${src ? `<img src="${src}" class="cart-thumb" alt="">` : `<div class="cart-item-emoji" style="background:${esc(p.bg)}">${esc(p.emoji)}</div>`}
      <div class="cart-item-info">
        <h4>${esc(p.name)}</h4>
        ${l.size ? `<span class="cart-variant-tag">📐 ${esc(l.size)}</span>` : ''}${l.color ? `<span class="cart-variant-tag">🎨 ${esc(l.color)}</span>` : ''}
        <div class="cart-item-price">${rs(p.price * l.qty)}</div>
        ${short ? `<div style="color:#dc2626;font-size:.72rem;font-weight:700;">Only ${p.stock} left — please reduce qty</div>` : ''}
        <div class="cart-item-qty">
          <button class="qty-btn" type="button" data-qty="${i}" data-d="-1" aria-label="Decrease">−</button>
          <span class="qty-num">${l.qty}</span>
          <button class="qty-btn" type="button" data-qty="${i}" data-d="1" aria-label="Increase">+</button>
        </div>
      </div>
      <button class="remove-item" type="button" data-remove="${i}" aria-label="Remove">🗑️</button>
    </div>`;
  }).join('');
  const t = calcTotals(lines.map((l) => ({ price: l.p.price, qty: l.qty })), state.settings, 'prepaid');
  $('subtotalAmt').textContent = rs(t.sub);
  $('shipAmt').textContent = t.ship ? rs(t.ship) : 'FREE';
  $('totalAmt').textContent = rs(t.total);
  const { freeAbove, shipping } = state.settings;
  $('freeShipNote').textContent = shipping && freeAbove && t.sub < freeAbove ? `Add ₹${(freeAbove - t.sub).toLocaleString('en-IN')} more for FREE delivery!` : '';
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
  if (n === 2) renderLogin($('checkoutLogin'), 'Log in to place your order');
  if (n === 3) renderAddressStep();
  if (n === 4) renderPayment();
}

// ---------- address ----------
// Address form fields: checkout uses ids custName…, My Account uses accName…
const ADDR_FIELDS = { name: 'Name', phone: 'Phone', line1: 'Addr1', line2: 'Addr2', landmark: 'Landmark', city: 'City', state: 'State', pincode: 'Pincode', altPhone: 'AltPhone' };
function readAddressForm(prefix = 'cust') {
  const a = {};
  for (const [k, id] of Object.entries(ADDR_FIELDS)) a[k] = $(prefix + id).value.trim();
  a.phone = a.phone.replace(/\D/g, '').slice(-10);
  return a;
}
function fillAddressForm(prefix, a) {
  for (const [k, id] of Object.entries(ADDR_FIELDS)) $(prefix + id).value = (a && a[k]) || '';
}
async function saveAddressList(list) {
  await db.collection('users').doc(state.user.uid).update({ addresses: list.slice(0, 10), updatedAt: Date.now() });
}
function addressError(a) {
  if (!a.name || a.name.length < 2) return 'Please enter your name';
  if (!/^[6-9]\d{9}$/.test(a.phone)) return 'Please enter a valid 10-digit mobile number';
  if (!a.line1 || a.line1.length < 3) return 'Please enter house / street';
  if (!a.city) return 'Please enter city';
  if (!a.state) return 'Please select your state';
  if (!/^[1-9]\d{5}$/.test(a.pincode)) return 'Please enter a valid 6-digit pincode';
  return '';
}
function addressText(a) {
  return [a.line1, a.line2, a.landmark, a.city, a.state].filter(Boolean).join(', ') + ' - ' + a.pincode;
}
let selectedAddressIndex = -1;
let addressPicked = false; // the customer chose a card themselves (e.g. "New address"): don't auto-select
let editAddressIndex = -1;  // checkout: the saved address being edited in the form
function renderAddressStep() {
  const saved = (state.profile && state.profile.addresses) || [];
  if (selectedAddressIndex >= saved.length) selectedAddressIndex = -1;
  if (selectedAddressIndex === -1 && saved.length && !addressPicked && !$('custName').value) selectedAddressIndex = 0;
  if (editAddressIndex >= saved.length) editAddressIndex = -1;
  $('savedAddresses').innerHTML = saved.length ? saved.map((a, i) => `
    <label class="addr-card ${selectedAddressIndex === i ? 'selected' : ''}">
      <input type="radio" name="addrPick" value="${i}" ${selectedAddressIndex === i ? 'checked' : ''}>
      <span><b>${esc(a.name)}</b> · ${esc(a.phone)}<br>${esc(addressText(a))}</span>
      <button type="button" class="addr-edit" data-edit-addr="${i}">✏️ Edit</button></label>`).join('')
    + `<label class="addr-card ${selectedAddressIndex === -1 ? 'selected' : ''}"><input type="radio" name="addrPick" value="-1" ${selectedAddressIndex === -1 ? 'checked' : ''}><span>${editAddressIndex >= 0 ? '✏️ Editing saved address' : '➕ New address'}</span></label>` : '';
  $('saveAddress').closest('label').style.display = editAddressIndex >= 0 ? 'none' : '';
  $('addressForm').style.display = selectedAddressIndex === -1 ? 'block' : 'none';
  if (selectedAddressIndex === -1 && !$('custPhone').value && userPhone(state.user)) {
    $('custPhone').value = userPhone(state.user).replace(/^\+91/, '');
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
    if (editAddressIndex >= 0 && saved[editAddressIndex]) {
      const list = [...saved]; list[editAddressIndex] = a;
      try { await saveAddressList(list); } catch (e) { console.error('Address update', e); }
      selectedAddressIndex = editAddressIndex; editAddressIndex = -1;
    } else if ($('saveAddress').checked) await saveAddressToProfile(a);
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
  $('codBlockedNote').innerHTML = blockers.length ? `🚫 COD not available for: <b>${blockers.map(esc).join(', ')}</b>` : '';
  if (state.payMethod === 'cod' && !codOk) state.payMethod = '';
  if (!state.payMethod) state.payMethod = 'razorpay'; // online is the default; COD is one tap away
  const codT = calcTotals(lines, s, 'cod');
  $('codSmall').textContent = codOk ? (codT.advance ? `${rs(codT.advance)} advance` : 'Full amount on delivery') : '';
  document.querySelectorAll('[data-pay]').forEach((b) => b.classList.toggle('selected', b.dataset.pay === state.payMethod));

  const t = calcTotals(lines, s, state.payMethod === 'cod' ? 'cod' : 'prepaid');
  let html = `<div class="sum-row"><span>Subtotal</span><span>${rs(t.sub)}</span></div>
    <div class="sum-row"><span>🚚 Shipping</span><span>${t.ship ? rs(t.ship) : 'FREE'}</span></div>`;
  if (t.codCharge) html += `<div class="sum-row"><span>💵 COD charge</span><span>${rs(t.codCharge)}</span></div>`;
  html += `<div class="sum-row total"><span>Total</span><span>${rs(t.total)}</span></div>`;
  if (state.payMethod === 'cod') {
    if (t.advance) html += `<div class="sum-row adv"><span>Advance (pay now)</span><span>${rs(t.advance)}</span></div>`;
    html += `<div class="sum-row bal"><span>Cash due on delivery</span><span>${rs(t.balance)}</span></div>`;
  }
  $('payBreakdown').innerHTML = html;
  const a = state.address;
  $('shipTo').innerHTML = a ? `📍 <b>${esc(a.name)}</b> · ${esc(a.phone)}<br>${esc(addressText(a))} <button type="button" class="link-like" data-step="3">Change</button>` : '';
  const btn = $('placeOrderBtn');
  btn.disabled = !state.payMethod || state.placing;
  btn.textContent = state.placing ? '⏳ Please wait...'
    : !state.payMethod ? 'Choose payment method'
      : state.payMethod === 'razorpay' ? `🔒 Pay ${rs(t.total)} via Card / UPI`
        : t.advance ? `🔒 Pay ${rs(t.advance)} advance` : '✅ Place COD Order';
  $('payErr').textContent = '';
}

// Test mode only: a stand-in for Razorpay that signs with the local test secret
function fakeRazorpay() {
  window.Razorpay = function (o) { this.o = o; };
  window.Razorpay.prototype.on = function () {};
  window.Razorpay.prototype.open = async function () {
    if (!confirm(`🧪 TEST PAYMENT\n\n${this.o.description}\nAmount: ₹${this.o.amount / 100}\n\nOK = payment successful, Cancel = payment cancelled`)) return this.o.modal.ondismiss();
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
    s.onerror = () => reject(new Error('Payment page failed to load. Please check your internet.'));
    document.head.appendChild(s);
  });
}

async function placeOrder() {
  if (state.placing || !state.payMethod) return;
  if (!cfg.workerUrl) {
    const lines = cartLines();
    const msg = 'Hello HMI Fashion! I would like to order:\n' + lines.map((l) => `▪️ ${l.p.name}${l.size ? ' [' + l.size + ']' : ''}${l.color ? ' [' + l.color + ']' : ''} x${l.qty}`).join('\n')
      + (state.address ? `\n\n📍 ${state.address.name}, ${state.address.phone}\n${addressText(state.address)}` : '');
    $('payErr').innerHTML = `Online ordering is coming soon. <a href="https://wa.me/${WA}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Order on WhatsApp →</a>`;
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
            $('payErr').textContent = '⚠️ Payment received, but we could not confirm it. No need to worry — your order will show in "My Orders" shortly. Order no: ' + res.orderNo;
          }
          resolve();
        },
        modal: { ondismiss: () => { $('payErr').textContent = 'Payment was not completed. You can try again.'; resolve(); } },
      });
      rz.on('payment.failed', (r) => { $('payErr').textContent = '❌ Payment fail: ' + ((r.error && r.error.description) || 'please try again'); });
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
  $('successWaBtn').href = `https://wa.me/${WA}?text=${encodeURIComponent(`Hello HMI Fashion! I have placed order ${orderNo}.`)}`;
  $('successOverlay').classList.add('open');
}

// =====================================================================
// LOGIN (number + PIN, Phone OTP, Google, email link) — used in checkout and in My Account
// =====================================================================
let recaptcha = null, confirmation = null;
// +91 number of the logged-in customer: from SMS OTP, or from a PIN account's uid ("pin_<number>")
function userPhone(u) {
  if (!u) return '';
  if (u.phoneNumber) return u.phoneNumber;
  return /^pin_\d{10}$/.test(u.uid) ? '+91' + u.uid.slice(4) : '';
}
function friendlyAuth(e) {
  const map = {
    'auth/invalid-phone-number': 'Invalid mobile number.',
    'auth/invalid-verification-code': 'Incorrect OTP. Please check and try again.',
    'auth/code-expired': 'OTP expired. Please request a new one.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/popup-closed-by-user': 'Google sign-in window was closed.',
    'auth/popup-blocked': 'Popup blocked. Please allow popups in your browser.',
    'auth/network-request-failed': 'Please check your internet connection.',
    'auth/billing-not-enabled': 'SMS OTP is not available right now. Please log in with Google or email.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/invalid-action-code': 'This login link has expired or was already used. Please request a new one.',
    'auth/expired-action-code': 'This login link has expired. Please request a new one.',
    'auth/operation-not-allowed': 'This login method is not available right now.',
    'auth/configuration-not-found': 'Login is being set up. Please try again later or order on WhatsApp.',
    'auth/unauthorized-domain': 'Login is being set up. Please try again later.',
    'auth/quota-exceeded': 'Daily limit reached. Please log in with Google.',
  };
  return map[e.code] || e.message;
}
function renderLogin(box, subtitle) {
  const pinOn = cfg.pinLogin !== false, otpOn = cfg.phoneOtp !== false;
  box.innerHTML = `
    <div class="login-box">
      <div class="otp-icon">📱</div>
      <div class="otp-title">Welcome to HMI Fashion</div>
      <div class="otp-sub">${esc(subtitle || 'Log in for your orders and wishlist')}</div>
      ${pinOn ? `
      <div data-phase="pin">
        <div class="pin-mode" data-el="pinTitle">Log in with mobile &amp; PIN</div>
        <div class="phone-row"><span class="cc">+91</span>
          <input class="field-input" data-el="pinPhone" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit mobile number" autocomplete="tel-national"></div>
        <input class="field-input otp-input" data-el="pin" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN" autocomplete="current-password">
        <div data-el="pinNew" style="display:none">
          <div class="otp-sub" data-el="pinNewMsg" style="margin:4px 0 8px"></div>
          <input class="field-input otp-input" data-el="pin2" type="password" inputmode="numeric" maxlength="4" placeholder="Confirm PIN" autocomplete="new-password">
        </div>
        <button class="cart-footer-btn btn-proceed" type="button" data-act="pinGo">Log in</button>
        <div class="pin-links">
          <button class="link-like" type="button" data-act="pinMode">New here? Generate PIN</button>
          <button class="link-like" type="button" data-el="pinForgot">Forgot PIN?</button>
        </div>
      </div>` : ''}
      <div data-phase="phone"${!otpOn || pinOn ? ' style="display:none"' : ''}>
        <div class="phone-row"><span class="cc">+91</span>
          <input class="field-input" data-el="phone" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit mobile number" autocomplete="tel-national"></div>
        <button class="cart-footer-btn btn-proceed" type="button" data-act="send">📲 Send OTP</button>
      </div>
      <div data-phase="otp" style="display:none">
        <div class="otp-sub">OTP sent to: <b data-el="sentTo"></b></div>
        <input class="field-input otp-input" data-el="code" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="one-time-code">
        <button class="cart-footer-btn btn-proceed" type="button" data-act="verify">✅ Verify OTP</button>
        <button class="link-like" type="button" data-act="change" style="margin-top:10px">Change number</button>
      </div>
      <div class="form-err" data-el="err"></div>
      ${pinOn && otpOn ? '<button class="link-like" type="button" data-act="otpToggle">Use SMS OTP instead</button>' : ''}
      ${pinOn || otpOn ? '<div class="or-line">or</div>' : ''}
      <button class="google-btn" type="button" data-act="google"><img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" width="18" height="18" alt=""> Continue with Google</button>
      <button class="google-btn" type="button" data-act="emailToggle" style="margin-top:10px">Continue with email link</button>
      <div data-phase="email" style="display:none;margin-top:10px">
        <input class="field-input" data-el="email" type="email" placeholder="Your email address" autocomplete="email">
        <button class="cart-footer-btn btn-proceed" type="button" data-act="sendLink">✉️ Send login link</button>
      </div>
      <div class="cart-note" data-el="emailSent" style="display:none"></div>
      <div class="login-secure">🔒 Secure login · we never share your number</div>
    </div>`;
  const q = (s) => box.querySelector(s);
  const err = (m) => { q('[data-el=err]').textContent = m || ''; };
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

  if (pinOn) {
    const pinNew = q('[data-el=pinNew]'), go = q('[data-act=pinGo]');
    const digits = (el) => el.value.replace(/\D/g, '');
    // Two modes: log in with an existing PIN, or generate (create) a new one
    let creating = false;
    const goLabel = () => (creating ? 'Generate PIN' : 'Log in');
    const setMode = (create, msg) => {
      creating = create;
      pinNew.style.display = create ? 'block' : 'none';
      q('[data-el=pinNewMsg]').textContent = msg || 'Enter the same PIN again to confirm. Remember this PIN for next time.';
      q('[data-el=pinTitle]').textContent = create ? 'Create your PIN' : 'Log in with mobile & PIN';
      q('[data-el=pin]').placeholder = create ? 'Choose a 4-digit PIN' : '4-digit PIN';
      q('[data-el=pin]').autocomplete = create ? 'new-password' : 'current-password';
      q('[data-act=pinMode]').textContent = create ? 'Already have a PIN? Log in' : 'New here? Generate PIN';
      q('[data-el=pinForgot]').style.display = create ? 'none' : '';
      q('[data-el=pin2]').value = '';
      go.textContent = goLabel();
    };
    q('[data-act=pinMode]').addEventListener('click', () => { err(''); setMode(!creating); q('[data-el=pinPhone]').focus(); });
    // Forgot PIN: WhatsApp us with the number and a one-tap reset link for the admin
    q('[data-el=pinForgot]').addEventListener('click', () => {
      const phone = digits(q('[data-el=pinPhone]'));
      if (!/^[6-9]\d{9}$/.test(phone)) { err('Enter your mobile number above first, then tap "Forgot PIN?"'); q('[data-el=pinPhone]').focus(); return; }
      err('');
      const resetLink = location.origin + location.pathname.replace(/[^/]*$/, '') + 'admin.html#resetpin=' + phone;
      const msg = `Hello HMI Fashion! I forgot my login PIN for +91 ${phone}. Please reset it.\n\nReset link (for HMI admin): ${resetLink}`;
      window.open(`https://wa.me/${WA}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
      q('[data-el=pinNewMsg]').textContent = '';
      flash('📲 Send the WhatsApp message. We will reset your PIN, then tap "Generate PIN".');
    });
    const submit = async () => {
      const phone = digits(q('[data-el=pinPhone]')), pin = digits(q('[data-el=pin]'));
      if (!/^[6-9]\d{9}$/.test(phone)) return err('Please enter a valid 10-digit mobile number');
      if (pin.length !== 4) return err('Please enter a 4-digit PIN');
      if (creating && digits(q('[data-el=pin2]')) !== pin) return err('The two PINs do not match');
      err(''); busy(go, true, 'Please wait…');
      try {
        const r = await HMI.callWorker('/pin/login', { phone, pin, create: creating });
        if (r.status === 'new') { // logging in with a number that has no PIN yet
          setMode(true, 'This number is new. Enter the same PIN again to create your account.');
          q('[data-el=pin2]').focus();
          return;
        }
        await auth.signInWithCustomToken(r.token);
        flash(creating ? '✅ PIN generated, you are logged in' : '✅ Logged in');
      } catch (e) {
        if (creating && /already has a PIN/.test(e.message)) setMode(false);
        err(e.code ? friendlyAuth(e) : e.message);
      } finally { busy(go, false, goLabel()); }
    };
    go.addEventListener('click', submit);
    ['pin', 'pin2'].forEach((n) => q(`[data-el=${n}]`).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
    if (otpOn) {
      q('[data-act=otpToggle]').addEventListener('click', (ev) => {
        const toOtp = q('[data-phase=pin]').style.display !== 'none';
        q('[data-phase=pin]').style.display = toOtp ? 'none' : 'block';
        q('[data-phase=phone]').style.display = toOtp ? 'block' : 'none';
        q('[data-phase=otp]').style.display = 'none';
        ev.target.textContent = toOtp ? 'Use PIN instead' : 'Use SMS OTP instead';
        err('');
      });
    }
  }

  q('[data-act=send]').addEventListener('click', async (ev) => {
    const phone = q('[data-el=phone]').value.replace(/\D/g, '');
    if (!/^[6-9]\d{9}$/.test(phone)) return err('Please enter a valid 10-digit mobile number');
    err(''); busy(ev.target, true, '⏳ Sending...');
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
    } finally { busy(ev.target, false, '📲 Send OTP'); }
  });
  const verify = async (btn) => {
    const code = q('[data-el=code]').value.replace(/\D/g, '');
    if (code.length !== 6) return err('Please enter the 6-digit OTP');
    err(''); busy(btn, true, '⏳ Verifying...');
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
  q('[data-act=emailToggle]').addEventListener('click', () => {
    q('[data-phase=email]').style.display = 'block'; q('[data-el=email]').focus();
  });
  q('[data-act=sendLink]').addEventListener('click', async (ev) => {
    const email = q('[data-el=email]').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('Please enter a valid email address.');
    err(''); busy(ev.target, true, '⏳ Sending...');
    try {
      const url = location.origin + location.pathname + (HMI.emulator ? '?emulator=1&' : '?') + 'emailLogin=1';
      await auth.sendSignInLinkToEmail(email, { url, handleCodeInApp: true });
      localStorage.setItem('hmi_email_login', email);
      const sent = q('[data-el=emailSent]');
      sent.style.display = 'block';
      sent.textContent = `✅ Login link sent to ${email}. Open it on this device to log in (check Spam too).`;
      q('[data-phase=email]').style.display = 'none';
    } catch (e) { err(friendlyAuth(e)); } finally { busy(ev.target, false, '✉️ Send login link'); }
  });
}

// Finish an email-link login when the customer opens the link from their email
async function completeEmailLinkLogin() {
  if (!auth.isSignInWithEmailLink(location.href)) return;
  let email = localStorage.getItem('hmi_email_login');
  if (!email) email = prompt('Please confirm your email address to finish logging in');
  if (!email) return;
  try {
    await auth.signInWithEmailLink(email.trim(), location.href);
    localStorage.removeItem('hmi_email_login');
    flash('✅ Logged in');
  } catch (e) { flash('❌ ' + friendlyAuth(e), '#dc2626'); }
  history.replaceState(null, '', location.pathname + (HMI.emulator ? '?emulator=1' : ''));
}

// =====================================================================
// ACCOUNT: profile, wishlist, orders
// =====================================================================
auth.onAuthStateChanged(async (user) => {
  state.user = user;
  if (state.profileUnsub) { state.profileUnsub(); state.profileUnsub = null; }
  if (state.ordersUnsub) { state.ordersUnsub(); state.ordersUnsub = null; }
  state.profile = null; state.orders = [];
  if ($('accountBtn')) $('accountBtn').textContent = user ? '😊' : '👤'; // removed from the new header
  $('navAuth').textContent = user ? '↪' : '👤';
  $('navAuth').setAttribute('aria-label', user ? 'Sign out' : 'Sign in');
  renderUserBar();
  if (!user) {
    loadLocalWishlist(); renderAccount();
    // Logged out during checkout → back to the login step
    if (state.step >= 3 && $('cartSidebar').classList.contains('open')) goStep(2);
    return;
  }

  const ref = db.collection('users').doc(user.uid);
  try {
    const snap = await ref.get();
    const localWish = [...state.wishlist];
    if (!snap.exists) {
      await ref.set({
        name: user.displayName || '', email: user.email || '', phone: userPhone(user),
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
  flash(on ? '♥ Added to wishlist' : 'Removed from wishlist', on ? '' : '#6b7280');
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

function userLabel() {
  const u = state.user;
  if (!u) return '';
  return userPhone(u).replace(/^\+91/, '+91 ') || u.email || (state.profile && state.profile.name) || 'Customer';
}
function userBarHtml() {
  return state.user ? `<span>✅ Logged in as <b>${esc(userLabel())}</b></span>
    <button type="button" class="mini-btn danger" data-logout>🚪 Logout</button>` : '';
}
function renderUserBar() { $('checkoutUser').innerHTML = userBarHtml(); }

async function logout() {
  if (!state.user || !confirm('Log out of your account?')) return;
  try {
    await auth.signOut();
    closeAccount();
    flash('👋 Logged out');
  } catch (e) { flash('❌ ' + e.message, '#dc2626'); }
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
    $('accountSub').textContent = 'Log in to view your orders';
    renderLogin(body, 'Log in for orders, addresses and wishlist');
    return;
  }
  $('accTabs').style.display = state.user ? 'flex' : 'none';
  $('accountSub').textContent = state.user ? (state.profile && state.profile.name) || userPhone(state.user) || state.user.email || 'My Account' : 'Wishlist';
  document.querySelectorAll('#accTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const bar = state.user ? `<div class="acc-user">${userBarHtml()}</div>` : '';
  if (tab === 'orders') body.innerHTML = bar + renderOrdersTab();
  if (tab === 'wishlist') body.innerHTML = bar + renderWishlistTab();
  if (tab === 'addresses') {
    // keep what the customer is typing if the profile updates in the background
    if (state.accAddrEdit !== null && $('accAddrForm') && body.dataset.addrForm === String(state.accAddrEdit)) return;
    body.innerHTML = bar + renderAddressesTab();
    body.dataset.addrForm = state.accAddrEdit === null ? '' : String(state.accAddrEdit);
  }
  if (tab === 'profile') body.innerHTML = bar + renderProfileTab();
}

function renderOrdersTab() {
  if (!state.orders.length) return '<div class="empty-msg"><div class="big">📦</div>No orders yet.<br><button type="button" class="mini-btn" data-close-account style="margin-top:12px">🛍️ Start shopping</button></div>';
  return state.orders.map((o) => {
    const cur = HMI.STATUS.indexOf(o.status);
    const steps = o.status === 'Cancelled'
      ? '<div class="cancelled-box" style="margin:8px 0;">❌ This order was cancelled.' + (o.payment.refundDue ? ` Your refund of ${rs(o.payment.refundDue)} will arrive in 5-7 days.` : '') + '</div>'
      : `<div class="track-timeline" style="margin:10px 0;">${HMI.STATUS.map((s, i) => `
          <div class="track-step ${i <= cur ? 'done' : 'inactive'}"><div class="track-icon">${i <= cur ? HMI.STATUS_ICON[s] : '○'}</div>
          <div class="track-info"><h4>${{ Pending: 'Order Placed', Confirmed: 'Confirmed', Shipped: 'Shipped', Delivered: 'Delivered' }[s]}</h4>
          <p>${o.statusTimes[s] ? fmtDate(o.statusTimes[s]) : 'Not yet'}</p></div></div>`).join('')}</div>`;
    const trk = o.tracking && (o.tracking.id || o.tracking.courier)
      ? `<div class="ship-to" style="margin:6px 0;">🚚 ${esc(o.tracking.courier || 'Courier')} ${o.tracking.id ? '· AWB <b>' + esc(o.tracking.id) + '</b>' : ''}
         ${o.tracking.url && safeUrl(o.tracking.url) ? ` · <a href="${safeUrl(o.tracking.url)}" target="_blank" rel="noopener">Track order →</a>` : ''}</div>` : '';
    return `<div class="order-card">
      <div class="order-card-head"><div><b>${esc(o.orderNo)}</b><br><span style="font-size:.72rem;color:var(--gray)">${fmtDate(o.createdAt)}</span></div>
        <span class="ostatus ${esc(o.status)}">${HMI.STATUS_ICON[o.status] || ''} ${esc(o.status)}</span></div>
      ${o.items.map((i) => `<div class="order-line">${i.image && safeUrl(i.image) ? `<img src="${safeUrl(i.image)}" alt="">` : `<span class="oemoji">${esc(i.emoji)}</span>`}
        <span style="flex:1">${esc(i.name)}${i.size ? ' · ' + esc(i.size) : ''}${i.color ? ' · ' + esc(i.color) : ''} × ${i.qty}</span><b>${rs(i.price * i.qty)}</b></div>`).join('')}
      <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-top:6px;"><span>${esc(payLabel(o.payment))}</span><b>Total ${rs(o.total)}</b></div>
      ${o.payment.method === 'cod' && o.payment.balance && o.status !== 'Cancelled' ? `<div style="font-size:.78rem;color:#16a34a;font-weight:700;">Pay ${rs(o.payment.balance)} cash on delivery</div>` : ''}
      ${trk}${steps}
      <div class="order-actions">
        ${o.status === 'Pending' ? `<button type="button" class="mini-btn danger" data-cancel="${esc(o.orderNo)}">✖ Cancel order</button>` : ''}
        <a class="mini-btn wa" target="_blank" rel="noopener" href="https://wa.me/${WA}?text=${encodeURIComponent('Hello HMI Fashion! I need help with my order ' + o.orderNo + '.')}">💬 Help</a>
      </div></div>`;
  }).join('');
}
function renderWishlistTab() {
  const list = [...state.wishlist].map(findProduct).filter(Boolean);
  if (!list.length) return '<div class="empty-msg"><div class="big">♡</div>Your wishlist is empty.<br>Tap ♡ on a product to save it.</div>';
  return (state.user ? '' : '<div class="ship-to" style="margin-bottom:10px;">💡 Log in to see your wishlist on every device.</div>')
    + list.map((p) => `<div class="order-card" style="display:flex;gap:12px;align-items:center;">
      <div style="width:60px;height:60px;border-radius:10px;overflow:hidden;background:${esc(p.bg)};display:flex;align-items:center;justify-content:center;font-size:2rem;flex-shrink:0;">${imgOrEmoji(p, '', 'width:100%;height:100%;object-fit:cover;')}</div>
      <div style="flex:1;"><b>${esc(p.name)}</b><br><span style="color:var(--pink-deep);font-weight:800;">${rs(p.price)}</span> ${outOfStock(p) ? '<span class="qty-badge qty-out">Out of Stock</span>' : ''}</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button type="button" class="mini-btn" data-pdp="${esc(p.id)}" data-close-account>👁️ View</button>
        <button type="button" class="mini-btn danger" data-wish="${esc(p.id)}">✖ Remove</button></div></div>`).join('');
}
function renderAddressesTab() {
  const list = (state.profile && state.profile.addresses) || [];
  if (state.accAddrEdit !== null) {
    return `<div id="accAddrForm">
      <div class="addr-title">${state.accAddrEdit === -1 ? '➕ New address' : '✏️ Edit address'}</div>
      <input class="field-input" id="accName" placeholder="Full Name *" autocomplete="name" maxlength="80">
      <input class="field-input" id="accPhone" placeholder="Mobile number (10 digit) *" type="tel" inputmode="numeric" maxlength="10" autocomplete="tel-national">
      <input class="field-input" id="accAddr1" placeholder="House / Flat No, Street *" autocomplete="address-line1" maxlength="200">
      <input class="field-input" id="accAddr2" placeholder="Area, Colony" autocomplete="address-line2" maxlength="200">
      <input class="field-input" id="accLandmark" placeholder="Landmark (optional)" maxlength="120">
      <div class="field-row">
        <input class="field-input" id="accCity" placeholder="City *" autocomplete="address-level2" maxlength="80">
        <select class="field-input state-select" id="accState" autocomplete="address-level1" required>${$('custState').innerHTML}</select>
      </div>
      <div class="field-row">
        <input class="field-input" id="accPincode" placeholder="Pincode *" type="tel" inputmode="numeric" maxlength="6" autocomplete="postal-code">
        <input class="field-input" id="accAltPhone" placeholder="Alt. Phone (optional)" type="tel" inputmode="numeric" maxlength="10">
      </div>
      <div class="form-err" id="accAddrErr"></div>
      <div class="acc-addr-btns">
        <button type="button" class="cart-footer-btn btn-proceed" id="accAddrSave">💾 Save address</button>
        <button type="button" class="cart-footer-btn btn-back" data-acc-addr-cancel>Cancel</button>
      </div></div>`;
  }
  const add = '<button type="button" class="cart-footer-btn btn-back" data-acc-addr-new style="margin-top:4px">➕ Add address</button>';
  if (!list.length) return '<div class="empty-msg"><div class="big">📍</div>No saved addresses yet.</div>' + add;
  return list.map((a, i) => `<div class="addr-card" style="cursor:default"><span><b>${esc(a.name)}</b> · ${esc(a.phone)}<br>${esc(addressText(a))}</span>
    <button type="button" class="addr-edit" data-acc-addr-edit="${i}">✏️ Edit</button>
    <button type="button" class="addr-del" data-del-addr="${i}" aria-label="Delete">🗑️</button></div>`).join('') + add;
}
// My Account → Address: open the form (index, or -1 for a new one), save, cancel
function openAccAddressForm(i) {
  const list = (state.profile && state.profile.addresses) || [];
  state.accAddrEdit = i;
  renderAccount();
  fillAddressForm('acc', i >= 0 ? list[i] : { name: (state.profile && state.profile.name) || '', phone: userPhone(state.user).replace(/^\+91/, '') });
  $(i >= 0 ? 'accAddr1' : 'accName').focus();
}
function closeAccAddressForm() { state.accAddrEdit = null; renderAccount(); }
async function saveAccAddress() {
  const a = readAddressForm('acc');
  const err = addressError(a);
  if (err) { $('accAddrErr').textContent = '❌ ' + err; return; }
  const list = [...((state.profile && state.profile.addresses) || [])];
  if (state.accAddrEdit >= 0 && list[state.accAddrEdit]) list[state.accAddrEdit] = a; else list.unshift(a);
  $('accAddrSave').disabled = true;
  try {
    await saveAddressList(list);
    flash('✅ Address saved');
    closeAccAddressForm();
  } catch (e) {
    $('accAddrErr').textContent = '❌ ' + e.message;
    $('accAddrSave').disabled = false;
  }
}
function renderProfileTab() {
  const p = state.profile || {};
  return `<label class="check-line" style="display:block;font-weight:700;">Name</label>
    <input class="field-input" id="profName" value="${esc(p.name || '')}" maxlength="100" placeholder="Your name">
    <div class="ship-to" style="margin-bottom:12px;">📱 ${esc(userPhone(state.user) || p.phone || '—')}<br>📧 ${esc(state.user.email || p.email || '—')}</div>
    <button type="button" class="cart-footer-btn btn-proceed" id="profSave">💾 Save</button>
    <button type="button" class="cart-footer-btn btn-back" id="logoutBtn">🚪 Logout</button>`;
}

async function cancelMyOrder(orderNo) {
  if (!confirm(`Cancel order ${orderNo}?`)) return;
  try {
    const r = await HMI.callWorker('/orders/cancel', { orderNo });
    flash(r.refundDue ? `Order cancelled. Refund of ${rs(r.refundDue)} in 5-7 days.` : 'Order cancelled');
  } catch (e) { flash('❌ ' + e.message, '#dc2626'); }
}

// =====================================================================
// EVENTS
// =====================================================================
document.addEventListener('click', (e) => {
  const dot = e.target.closest('[data-dot]');
  if (dot) { const g = dot.closest('[data-gallery]'); if (g && g.go) g.go(Number(dot.dataset.dot)); return; }
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
  if (t.dataset.tab !== undefined) { state.accountTab = t.dataset.tab; state.accAddrEdit = null; renderAccount(); return; }
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
  if (e.target.name === 'addrPick') {
    selectedAddressIndex = Number(e.target.value); addressPicked = true; editAddressIndex = -1;
    // a fresh form for the new address (name and mobile usually stay the same)
    if (selectedAddressIndex === -1) ['custAddr1', 'custAddr2', 'custLandmark', 'custCity', 'custState', 'custPincode', 'custAltPhone'].forEach((id) => { $(id).value = ''; });
    renderAddressStep();
    if (selectedAddressIndex === -1) $('custAddr1').focus();
  }
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'profSave') {
    const name = $('profName').value.trim().slice(0, 100);
    db.collection('users').doc(state.user.uid).update({ name, updatedAt: Date.now() })
      .then(() => flash('✅ Saved')).catch((err) => flash('❌ ' + err.message, '#dc2626'));
  }
  if (e.target.id === 'logoutBtn' || e.target.closest('[data-logout]')) logout();
  if (e.target.id === 'accAddrSave') saveAccAddress();
  const accEdit = e.target.closest('[data-acc-addr-edit]');
  if (accEdit) openAccAddressForm(Number(accEdit.dataset.accAddrEdit));
  if (e.target.closest('[data-acc-addr-new]')) openAccAddressForm(-1);
  if (e.target.closest('[data-acc-addr-cancel]')) closeAccAddressForm();
  // Checkout: edit a saved address in the form below the cards
  const coEdit = e.target.closest('[data-edit-addr]');
  if (coEdit) {
    e.preventDefault();
    const i = Number(coEdit.dataset.editAddr), saved = (state.profile && state.profile.addresses) || [];
    if (!saved[i]) return;
    editAddressIndex = i; selectedAddressIndex = -1; addressPicked = true;
    fillAddressForm('cust', saved[i]);
    renderAddressStep();
    $('custAddr1').focus();
  }
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
$('navAuth').addEventListener('click', (e) => {
  e.preventDefault();
  $('navMenu').classList.remove('open');
  if (state.user) logout(); else openAccount('orders');
});
$('accountOverlay').addEventListener('click', (e) => { if (e.target.id === 'accountOverlay') closeAccount(); });
$('successCloseBtn').addEventListener('click', () => $('successOverlay').classList.remove('open'));
$('successOrdersBtn').addEventListener('click', () => { $('successOverlay').classList.remove('open'); openAccount('orders'); });
$('shopClear').addEventListener('click', () => { state.activeCat = 'all'; state.search = ''; $('searchInput').value = ''; renderCategories(); renderProducts(); });
let searchTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    renderProducts();
  }, 200);
});
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && $('searchInput').value.trim()) {
    $('products').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
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
completeEmailLinkLogin();
