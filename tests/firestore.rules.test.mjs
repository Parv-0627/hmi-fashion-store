// Firestore security rules tests. Run with: npm run test:rules
// Uses the local emulator only; never touches the live database.
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs,
} from 'firebase/firestore';

let env;

const product = {
  name: 'Banarasi Silk Saree', price: 2499, mrp: 3999, stock: 10,
  category: 'Saree', images: [], active: true,
};
const order = {
  orderNo: 'HMI-TEST-1', userId: 'alice', status: 'Pending', total: 2598,
  items: [{ productId: 'p1', name: 'Banarasi Silk Saree', price: 2499, qty: 1 }],
  statusTimes: { Pending: 1 },
};

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-hmi',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'admins/boss'), { email: 'admin@example.com' });
    await setDoc(doc(db, 'products/p1'), product);
    await setDoc(doc(db, 'categories/Saree'), { name: 'Sarees' });
    await setDoc(doc(db, 'settings/store'), { shipping: 99 });
    await setDoc(doc(db, 'users/alice'), { name: 'Alice', createdAt: 1 });
    await setDoc(doc(db, 'orders/HMI-TEST-1'), order);
    await setDoc(doc(db, 'orders/LEGACY-1'), { orderNo: 'ORD1234', customerPhone: '9999999999' });
  });
});

const anon = () => env.unauthenticatedContext().firestore();
const alice = () => env.authenticatedContext('alice').firestore();
const bob = () => env.authenticatedContext('bob').firestore();
const admin = () => env.authenticatedContext('boss').firestore();

// ---------- Catalogue ----------
test('anyone can read products, categories and settings', async () => {
  await assertSucceeds(getDoc(doc(anon(), 'products/p1')));
  await assertSucceeds(getDoc(doc(anon(), 'categories/Saree')));
  await assertSucceeds(getDoc(doc(anon(), 'settings/store')));
});

test('customers and visitors cannot change products or prices', async () => {
  await assertFails(updateDoc(doc(anon(), 'products/p1'), { price: 1 }));
  await assertFails(updateDoc(doc(alice(), 'products/p1'), { price: 1 }));
  await assertFails(setDoc(doc(alice(), 'products/p2'), product));
  await assertFails(deleteDoc(doc(alice(), 'products/p1')));
  await assertFails(setDoc(doc(alice(), 'settings/store'), { shipping: 0 }));
  await assertFails(setDoc(doc(alice(), 'categories/Free'), { name: 'Free' }));
});

test('admin can manage products, categories and settings', async () => {
  await assertSucceeds(updateDoc(doc(admin(), 'products/p1'), { price: 1999 }));
  await assertSucceeds(setDoc(doc(admin(), 'products/p2'), product));
  await assertSucceeds(deleteDoc(doc(admin(), 'products/p2')));
  await assertSucceeds(setDoc(doc(admin(), 'categories/Kurti'), { name: 'Kurtis' }));
  await assertSucceeds(setDoc(doc(admin(), 'settings/store'), { shipping: 79 }));
});

test('admin cannot save a broken product', async () => {
  await assertFails(setDoc(doc(admin(), 'products/bad'), { ...product, price: -5 }));
  await assertFails(setDoc(doc(admin(), 'products/bad'), { ...product, stock: 1.5 }));
  await assertFails(setDoc(doc(admin(), 'products/bad'), { ...product, name: '' }));
});

test('nobody can make themselves admin from the browser', async () => {
  await assertFails(setDoc(doc(alice(), 'admins/alice'), { email: 'x' }));
  await assertFails(setDoc(doc(admin(), 'admins/alice'), { email: 'x' }));
  await assertFails(getDoc(doc(alice(), 'admins/boss')));
});

// ---------- Customers ----------
test('customers can only see and edit their own profile', async () => {
  await assertSucceeds(getDoc(doc(alice(), 'users/alice')));
  await assertSucceeds(updateDoc(doc(alice(), 'users/alice'), { name: 'Alice K', addresses: [{ city: 'Delhi' }] }));
  await assertFails(getDoc(doc(bob(), 'users/alice')));
  await assertFails(updateDoc(doc(bob(), 'users/alice'), { name: 'Hacked' }));
  await assertFails(getDoc(doc(anon(), 'users/alice')));
});

test('customers cannot add unknown fields like a role to their profile', async () => {
  await assertFails(updateDoc(doc(alice(), 'users/alice'), { role: 'admin' }));
  await assertFails(updateDoc(doc(alice(), 'users/alice'), { createdAt: 999 }));
  await assertSucceeds(setDoc(doc(bob(), 'users/bob'), { name: 'Bob', createdAt: 5 }));
});

test('admin can read customer profiles', async () => {
  await assertSucceeds(getDoc(doc(admin(), 'users/alice')));
});

// ---------- Orders ----------
test('orders cannot be created from the browser', async () => {
  await assertFails(setDoc(doc(alice(), 'orders/HMI-NEW'), { ...order, total: 1 }));
  await assertFails(setDoc(doc(anon(), 'orders/HMI-NEW'), order));
  await assertFails(setDoc(doc(admin(), 'orders/HMI-NEW'), order));
});

test('customers see only their own orders', async () => {
  await assertSucceeds(getDoc(doc(alice(), 'orders/HMI-TEST-1')));
  await assertSucceeds(getDocs(query(collection(alice(), 'orders'), where('userId', '==', 'alice'))));
  await assertFails(getDoc(doc(bob(), 'orders/HMI-TEST-1')));
  await assertFails(getDocs(collection(bob(), 'orders')));
  await assertFails(getDoc(doc(anon(), 'orders/HMI-TEST-1')));
  await assertFails(getDoc(doc(alice(), 'orders/LEGACY-1')));
});

test('customers cannot change their orders directly (cancelling goes through the checkout server)', async () => {
  await assertFails(updateDoc(doc(alice(), 'orders/HMI-TEST-1'), { total: 1 }));
  await assertFails(updateDoc(doc(alice(), 'orders/HMI-TEST-1'), { status: 'Cancelled' }));
  await assertFails(updateDoc(doc(bob(), 'orders/HMI-TEST-1'), { status: 'Cancelled' }));
});

test('admin updates order status but cannot rewrite totals or items', async () => {
  await assertSucceeds(getDocs(collection(admin(), 'orders')));
  await assertSucceeds(updateDoc(doc(admin(), 'orders/HMI-TEST-1'), { status: 'Shipped', tracking: { courier: 'Delhivery', id: 'X1' } }));
  await assertSucceeds(updateDoc(doc(admin(), 'orders/HMI-TEST-1'), { status: 'Cancelled', stockRestored: true }));
  await assertFails(updateDoc(doc(admin(), 'orders/HMI-TEST-1'), { total: 10 }));
  await assertFails(updateDoc(doc(admin(), 'orders/HMI-TEST-1'), { userId: 'bob' }));
  await assertSucceeds(deleteDoc(doc(admin(), 'orders/LEGACY-1')));
});

test('admin can change stock with an increment, customers cannot', async () => {
  const { increment } = await import('firebase/firestore');
  await assertSucceeds(updateDoc(doc(admin(), 'products/p1'), { stock: increment(2) }));
  await assertFails(updateDoc(doc(alice(), 'products/p1'), { stock: increment(100) }));
  await assertFails(updateDoc(doc(admin(), 'products/p1'), { stock: increment(-100) }));
});

test('everything else is closed', async () => {
  await assertFails(getDoc(doc(admin(), 'secrets/razorpay')));
  await assertFails(setDoc(doc(alice(), 'anything/x'), { a: 1 }));
});
