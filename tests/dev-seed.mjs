// Seeds the LOCAL Firebase emulators with test data for manual/browser testing.
//   npx firebase emulators:start --only firestore,auth --project hmi-fashion-store
//   node tests/dev-seed.mjs
// Then open http://localhost:5500/admin.html?emulator=1  (admin@test.local / test1234)
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

const AUTH = 'http://127.0.0.1:9099';
const PROJECT = 'hmi-fashion-store';

async function makeUser(email, password) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!data.localId) throw new Error(JSON.stringify(data));
  return data.localId;
}

await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host: '127.0.0.1', port: 8085 } });
await env.clearFirestore();

const adminUid = await makeUser('admin@test.local', 'test1234');
const custUid = await makeUser('customer@test.local', 'test1234');

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'admins', adminUid), { email: 'admin@test.local' });
  // Old single-list format, as the previous admin panel saved it
  await setDoc(doc(db, 'settings/products'), { list: [
    { id: 1, name: 'Banarasi Silk Saree', cat: 'Saree', emoji: '🥻', bg: '#fce7f3', price: 2499, old: 3999, badge: 'Bestseller', desc: 'Pure Banarasi silk', images: [], qty: 18, sizes: ['Free Size'], colors: [{ name: 'Red', hex: '#ef4444' }] },
    { id: 2, name: 'Printed Rayon Kurti', cat: 'Kurti', emoji: '🌺', bg: '#fef3c7', price: 499, old: 799, badge: 'Sale', desc: 'Rayon kurti', images: [], qty: 3, sizes: ['M', 'L', 'XL'], colors: [] },
    { id: 3, name: 'Sherwani Set', cat: 'Men', emoji: '🤵', bg: '#fef9c3', price: 5999, old: 8999, badge: 'Premium', desc: 'Royal sherwani', images: [], cod: false },
  ] });
  await setDoc(doc(db, 'settings/categories'), { list: [
    { id: 'Saree', name: 'Sarees', icon: '🥻', sub: 'Silk, Cotton & More' },
    { id: 'Kurti', name: 'Kurtis', icon: '👘', sub: 'Daily & Festive' },
    { id: 'Men', name: "Men's Wear", icon: '👔', sub: 'Kurta & Sherwanis' },
  ] });
  await setDoc(doc(db, 'settings/payment'), { shipping: 99, freeAbove: 1999, codEnabled: true, codCharge: 49, advanceType: 'fixed', advanceValue: 99 });
  await setDoc(doc(db, 'users', custUid), { name: 'Test Customer', phone: '+919876543210', email: 'customer@test.local', createdAt: Date.now() - 86400000 });
  await setDoc(doc(db, 'orders/ORD1234'), {
    orderNo: 'ORD1234', date: Date.now() - 3 * 86400000, customerName: 'Purana Customer', customerPhone: '9811111111',
    address: 'House 1, Sector 5, Gurgaon, Haryana - 122001', items: [{ id: 2, name: 'Printed Rayon Kurti', price: 499, qty: 2, selSize: 'M' }],
    subtotal: 998, shipping: 99, total: 1097, payMethod: 'QR Code', status: 'Shipped',
  });
  await setDoc(doc(db, 'orders/HMI-260101-AB12'), {
    orderNo: 'HMI-260101-AB12', userId: custUid, email: 'customer@test.local', customerName: 'Test Customer', customerPhone: '+919876543210',
    address: { name: 'Test Customer', phone: '9876543210', line1: 'Flat 2, Tower B', city: 'Gurgaon', state: 'Haryana', pincode: '122002' },
    items: [{ productId: '1', name: 'Banarasi Silk Saree', price: 2499, qty: 1, size: 'Free Size', color: 'Red' }],
    subtotal: 2499, shipping: 0, codCharge: 49, total: 2548,
    payment: { method: 'cod', status: 'advance_paid', advance: 99, balance: 2449, razorpayPaymentId: 'pay_test123' },
    status: 'Pending', statusTimes: { Pending: Date.now() - 3600000 }, createdAt: Date.now() - 3600000, stockDeducted: true,
  });
});
if (process.argv.includes('--catalogue')) {
  // Also write the new per-document catalogue (as if the admin already imported)
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const cats = [['Saree', 'Sarees', '🥻'], ['Kurti', 'Kurtis', '👘'], ['Men', "Men's Wear", '👔'], ['Kids', 'Kids Wear', '🧒']];
    for (const [i, [id, name, icon]] of cats.entries()) await setDoc(doc(db, 'categories', id), { name, icon, sub: '', order: i });
    const base = { active: true, cod: true, badge: '', desc: 'Test product', emoji: '👗', bg: '#fce7f3', sizes: [], colors: [], images: [], trackStock: true, updatedAt: Date.now() };
    await setDoc(doc(db, 'products/1'), { ...base, name: 'Banarasi Silk Saree', category: 'Saree', price: 2499, mrp: 3999, stock: 18, badge: 'Bestseller', colors: [{ name: 'Red', hex: '#ef4444' }, { name: 'Green', hex: '#22c55e' }], images: ['https://picsum.photos/seed/saree/600/800'], createdAt: 3 });
    await setDoc(doc(db, 'products/2'), { ...base, name: 'Printed Rayon Kurti', category: 'Kurti', price: 499, mrp: 799, stock: 3, sizes: ['M', 'L', 'XL'], createdAt: 2 });
    await setDoc(doc(db, 'products/3'), { ...base, name: 'Sherwani Set', category: 'Men', price: 5999, mrp: 8999, stock: 0, trackStock: false, cod: false, emoji: '🤵', createdAt: 1 });
    await setDoc(doc(db, 'products/4'), { ...base, name: 'Kids Party Frock', category: 'Kids', price: 799, mrp: 1299, stock: 0, emoji: '👸', createdAt: 4 });
  });
}
await env.cleanup();
console.log('Seeded. Admin: admin@test.local / test1234   Customer: customer@test.local / test1234');
