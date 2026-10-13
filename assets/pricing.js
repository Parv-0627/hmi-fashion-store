// HMI Fashion Store — order pricing.
// Single source of truth: the store shows these numbers, and the checkout
// worker imports this same file to charge them (so they can never disagree).
(function (root) {
  const DEFAULT_PAY = {
    shipping: 99, freeAbove: 0,
    codEnabled: true, codCharge: 0,
    advanceType: 'fixed', advanceValue: 99,
  };

  const num = (v) => Math.max(0, Math.round(Number(v) || 0));

  function paySettings(raw) {
    const s = { ...DEFAULT_PAY, ...(raw || {}) };
    return {
      shipping: num(s.shipping), freeAbove: num(s.freeAbove),
      codEnabled: s.codEnabled !== false, codCharge: num(s.codCharge),
      advanceType: ['none', 'fixed', 'percent', 'shipping'].includes(s.advanceType) ? s.advanceType : 'fixed',
      advanceValue: num(s.advanceValue),
    };
  }

  // lines: [{price, qty}]   method: 'cod' | 'prepaid'
  function calcTotals(lines, rawSettings, method) {
    const s = paySettings(rawSettings);
    const sub = lines.reduce((a, l) => a + num(l.price) * num(l.qty), 0);
    const ship = s.freeAbove > 0 && sub >= s.freeAbove ? 0 : s.shipping;
    if (method !== 'cod') {
      return { sub, ship, codCharge: 0, total: sub + ship, advance: sub + ship, balance: 0 };
    }
    const codCharge = s.codCharge;
    const total = sub + ship + codCharge;
    let advance = 0;
    if (s.advanceType === 'fixed') advance = s.advanceValue;
    else if (s.advanceType === 'percent') advance = Math.round(total * Math.min(s.advanceValue, 100) / 100);
    else if (s.advanceType === 'shipping') advance = ship + codCharge;
    advance = Math.min(advance, total);
    return { sub, ship, codCharge, total, advance, balance: total - advance };
  }

  root.HMIPricing = { DEFAULT_PAY, paySettings, calcTotals };
})(typeof window !== 'undefined' ? window : globalThis);
