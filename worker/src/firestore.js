// Minimal Firestore REST client for the worker (service account = bypasses security rules).
import { getAccessToken } from './google.js';

export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  throw new Error('Unsupported value: ' + typeof v);
}
export function toFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = toValue(v);
  return out;
}
export function fromValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
export function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
  return out;
}

export class Firestore {
  constructor(env) {
    this.project = env.FIREBASE_PROJECT_ID;
    this.emulator = env.FIRESTORE_EMULATOR_HOST || '';
    this.serviceAccount = env.FIREBASE_SERVICE_ACCOUNT;
    const host = this.emulator ? `http://${this.emulator}` : 'https://firestore.googleapis.com';
    this.root = `projects/${this.project}/databases/(default)/documents`;
    this.base = `${host}/v1/${this.root}`;
  }
  name(path) { return `${this.root}/${path}`; }

  async request(url, init = {}) {
    const token = this.emulator ? 'owner' : await getAccessToken(this.serviceAccount);
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Firestore ${res.status}: ${data.error?.message || res.statusText}`);
      err.status = res.status;
      err.firestoreStatus = data.error?.status;
      throw err;
    }
    return data;
  }

  async get(path) {
    try {
      const d = await this.request(`${this.base}/${path}`);
      return { id: path.split('/').pop(), ...fromFields(d.fields) };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Read several documents; with a transaction they are locked until commit
  async getMany(paths, transaction) {
    if (!paths.length) return [];
    const res = await this.request(`${this.base}:batchGet`, {
      method: 'POST',
      body: JSON.stringify({ documents: paths.map((p) => this.name(p)), ...(transaction ? { transaction } : {}) }),
    });
    const byName = {};
    for (const r of res) {
      if (r.found) byName[r.found.name] = { id: r.found.name.split('/').pop(), ...fromFields(r.found.fields) };
    }
    return paths.map((p) => byName[this.name(p)] || null);
  }

  async beginTransaction() {
    return (await this.request(`${this.base}:beginTransaction`, {
      method: 'POST', body: JSON.stringify({ options: { readWrite: {} } }),
    })).transaction;
  }

  async rollback(transaction) {
    try { await this.request(`${this.base}:rollback`, { method: 'POST', body: JSON.stringify({ transaction }) }); } catch { /* ignore */ }
  }

  // writes: [{ op:'create'|'set'|'update'|'delete', path, data, increments }]
  async commit(writes, transaction) {
    const body = {
      writes: writes.map((w) => {
        if (w.op === 'delete') return { delete: this.name(w.path) };
        const write = { update: { name: this.name(w.path), fields: toFields(w.data || {}) } };
        if (w.op === 'create') write.currentDocument = { exists: false };
        if (w.op === 'update') {
          write.currentDocument = { exists: true };
          write.updateMask = { fieldPaths: Object.keys(w.data || {}).map((k) => '`' + k.replace(/`/g, '\\`') + '`') };
        }
        if (w.increments) {
          write.updateTransforms = Object.entries(w.increments).map(([fieldPath, n]) => ({ fieldPath, increment: { integerValue: String(n) } }));
        }
        return write;
      }),
      ...(transaction ? { transaction } : {}),
    };
    return this.request(`${this.base}:commit`, { method: 'POST', body: JSON.stringify(body) });
  }
}
