// Google auth for the worker:
//  - verifyIdToken: checks a Firebase Auth ID token sent by the browser
//  - getAccessToken: service-account token for the Firestore REST API
//  - createCustomToken: log a customer in after the worker checked them (PIN login)
// Uses WebCrypto only, so it runs on Cloudflare Workers and in Node tests.

const b64url = {
  encode(bytes) {
    let s = '';
    new Uint8Array(bytes).forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '='));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};
const text = (bytes) => new TextDecoder().decode(bytes);
const json = (str) => JSON.parse(text(b64url.decode(str)));

export class AuthError extends Error {}

// ---------------- Firebase ID tokens ----------------
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache = { keys: null, expires: 0 };

async function signingKey(kid) {
  if (!jwksCache.keys || Date.now() > jwksCache.expires) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new AuthError('Could not load Google signing keys');
    const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
    jwksCache = { keys: (await res.json()).keys, expires: Date.now() + maxAge * 1000 };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) throw new AuthError('Unknown token key');
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

// Returns { uid, email, phone, name }. `emulator` skips the signature check
// (Firebase Auth emulator tokens are unsigned) and must never be set in production.
export async function verifyIdToken(token, projectId, { emulator = false } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('Login required');
  let header, payload;
  try { header = json(parts[0]); payload = json(parts[1]); } catch { throw new AuthError('Bad token'); }

  if (!emulator) {
    if (header.alg !== 'RS256') throw new AuthError('Bad token');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await signingKey(header.kid),
      b64url.decode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) throw new AuthError('Bad token signature');
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw new AuthError('Token is for another project');
  if (!payload.sub || payload.exp < now || payload.iat > now + 300) throw new AuthError('Login expired, please log in again');
  return {
    uid: payload.sub,
    email: payload.email || '',
    phone: payload.phone_number || '',
    name: payload.name || '',
  };
}

// ---------------- Service account access token ----------------
let tokenCache = { token: null, expires: 0 };

function pemToPkcs8(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

const encJson = (o) => b64url.encode(new TextEncoder().encode(JSON.stringify(o)));
const parseSa = (sa) => (typeof sa === 'string' ? JSON.parse(sa) : sa);

async function signJwt(sa, payload) {
  const unsigned = encJson({ alg: 'RS256', typ: 'JWT' }) + '.' + encJson(payload);
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64url.encode(sig);
}

export async function getAccessToken(serviceAccountJson) {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  const sa = parseSa(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(sa, {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + assertion,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Service account login failed: ' + (data.error_description || data.error));
  tokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 120) * 1000 };
  return tokenCache.token;
}

// ---------------- Logging a customer in from the worker ----------------
// Firebase custom token; the browser exchanges it with signInWithCustomToken.
// The Auth emulator accepts unsigned tokens, so tests need no real key.
export async function createCustomToken(serviceAccountJson, uid, { emulator = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const aud = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
  if (emulator) {
    const iss = 'firebase-auth-emulator@example.com';
    return encJson({ alg: 'none', typ: 'JWT' }) + '.' + encJson({ iss, sub: iss, aud, iat: now, exp: now + 3600, uid }) + '.';
  }
  const sa = parseSa(serviceAccountJson);
  return signJwt(sa, { iss: sa.client_email, sub: sa.client_email, aud, iat: now, exp: now + 3600, uid });
}

export async function sha256Hex(message) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string comparison for signatures
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
