// Mobile OTP login without Firebase's paid SMS.
//
//   POST /auth/otp/send    { phone }        -> creates a 6-digit code and delivers it
//   POST /auth/otp/verify  { phone, code }  -> checks it, returns a Firebase custom token
//
// Firestore (server only, closed to browsers by firestore.rules):
//   otps/{phone}         HMAC of the code, expiry, wrong tries, per-number send count
//   otpLimits/{ip_...}   sends per IP per hour
//   otpLimits/global     sends per day (protects the admin / SMS balance from bots)
//   otpRequests/{phone}  the code for the admin to send on WhatsApp (admin delivery,
//                        or when the SMS phone is offline / out of SMS for the day)
//   otpLimits/sms        SMS sent today through the Android gateway phone
//
// How the code reaches the customer is decided only in deliverOtp() below.
import { HttpError } from './errors.js';
import { hmacHex, safeEqual, createCustomToken, phoneUserUid } from './google.js';

const MAX_TRIES = 5;          // wrong codes before the OTP is locked
const RESEND_SECONDS = 60;    // wait between two OTPs for the same number
const PHONE_PER_HOUR = 5;     // OTPs per number per hour
const IP_PER_HOUR = 10;       // OTPs per IP address per hour
const HOUR = 3600 * 1000;

const isEmulator = (env) => !!env.FIRESTORE_EMULATOR_HOST && !!env.AUTH_EMULATOR_HOST;
const ttlMs = (env) => Math.min(Math.max(Number(env.OTP_TTL_MINUTES) || 5, 1), 30) * 60 * 1000;
const dailyLimit = (env) => Number(env.OTP_DAILY_LIMIT) || 300;
const istDay = (ms) => new Date(ms + 5.5 * HOUR).toISOString().slice(0, 10);

function cleanPhone(v) {
  const phone = String(v || '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(phone)) throw new HttpError(400, 'Please enter a valid 10-digit mobile number');
  return phone;
}

function secret(env) {
  const s = env.OTP_SECRET || env.FIREBASE_SERVICE_ACCOUNT || (isEmulator(env) ? 'emulator-only-secret' : '');
  if (!s) throw new HttpError(500, 'OTP login is not set up yet');
  return s;
}
const hashCode = (env, phone, code) => hmacHex(secret(env), `otp|${phone}|${code}`);

// Uniform 6-digit code from the crypto RNG (rejection sampling, no modulo bias)
function randomCode() {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= 4294000000);
  return String(buf[0] % 1000000).padStart(6, '0');
}

// Counter that resets one hour after it started
function hourWindow(w, now) {
  return w && now - w.start < HOUR ? { start: w.start, count: w.count || 0 } : { start: now, count: 0 };
}

function deliveryMode(env) {
  const mode = env.OTP_DELIVERY || 'admin';
  if (mode === 'screen' && !isEmulator(env)) throw new HttpError(500, 'OTP screen mode only works in test mode');
  if (!['admin', 'screen', 'sms'].includes(mode)) throw new HttpError(500, 'OTP delivery is not set up');
  return mode;
}

// Admin queue: shows up in admin.html -> "Login OTPs", admin sends it on WhatsApp
async function queueForAdmin(fs, { phone, code, expiresAt }, reason) {
  await fs.commit([{
    op: 'set', path: `otpRequests/${phone}`,
    data: { phone: '+91' + phone, code, status: 'pending', createdAt: Date.now(), expiresAt, ...(reason ? { reason } : {}) },
  }]);
  return { delivery: 'admin' };
}

// SMS through an Android phone running "SMS Gateway for Android" (sms-gate.app,
// cloud mode). The phone's own SIM sends it. Username/password from the app are
// wrangler secrets SMS_GATEWAY_USER / SMS_GATEWAY_PASS.
async function sendSms(env, phone, text) {
  const url = env.SMS_GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${env.SMS_GATEWAY_USER}:${env.SMS_GATEWAY_PASS}`) },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: ['+91' + phone] }),
  });
  if (!res.ok) throw new Error(`SMS gateway ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

// The only place that decides how a code reaches the customer.
async function deliverOtp(env, fs, { phone, code, expiresAt }) {
  const mode = deliveryMode(env);
  if (mode === 'screen') return { delivery: 'screen', devCode: code }; // emulator only
  if (mode === 'admin') return queueForAdmin(fs, { phone, code, expiresAt });

  // sms: a SIM pack allows ~100 SMS a day, keep a margin; anything that goes
  // wrong (phone offline, limit reached) falls back to the admin queue
  if (!env.SMS_GATEWAY_USER || !env.SMS_GATEWAY_PASS) return queueForAdmin(fs, { phone, code, expiresAt }, 'SMS gateway not set up');
  const today = istDay(Date.now());
  const counter = await fs.get('otpLimits/sms');
  const sentToday = counter && counter.day === today ? counter.count || 0 : 0;
  if (sentToday >= (Number(env.SMS_DAILY_LIMIT) || 90)) return queueForAdmin(fs, { phone, code, expiresAt }, 'Daily SMS limit reached');
  const mins = Math.round((expiresAt - Date.now()) / 60000);
  // Last line in WebOTP format so Chrome on Android can fill the code in by itself
  const text = `${code} is your HMI Fashion Store login OTP. It works for ${mins} minutes. Do not share it with anyone.\n\n@shop.hmitechnology.co.in #${code}`;
  try {
    await sendSms(env, phone, text);
  } catch (e) {
    console.error('SMS failed', e);
    return queueForAdmin(fs, { phone, code, expiresAt }, 'SMS phone did not respond');
  }
  await fs.commit([{ op: 'set', path: 'otpLimits/sms', data: { day: today, count: sentToday + 1 } }]);
  return { delivery: 'sms' };
}

export async function sendOtp(env, fs, { phone, ip }) {
  phone = cleanPhone(phone);
  deliveryMode(env); // fail before counting anything if delivery is misconfigured
  const ipKey = 'ip_' + (await hmacHex(secret(env), 'ip|' + (ip || 'unknown'))).slice(0, 32);
  let code, expiresAt;
  for (let attempt = 0; attempt < 4 && !code; attempt++) {
    const tx = await fs.beginTransaction();
    try {
      const now = Date.now();
      const [cur, ipDoc, day] = await fs.getMany([`otps/${phone}`, `otpLimits/${ipKey}`, 'otpLimits/global'], tx);
      const wait = cur ? Math.ceil((cur.sentAt + RESEND_SECONDS * 1000 - now) / 1000) : 0;
      if (wait > 0) throw new HttpError(429, `Please wait ${wait} seconds before asking for a new OTP`);
      const perPhone = hourWindow(cur && cur.hour, now);
      if (perPhone.count >= PHONE_PER_HOUR) throw new HttpError(429, 'Too many OTPs for this number. Please try again after an hour.');
      const perIp = hourWindow(ipDoc, now);
      if (perIp.count >= IP_PER_HOUR) throw new HttpError(429, 'Too many OTP requests. Please try again later.');
      const today = istDay(now);
      const todayCount = day && day.day === today ? day.count || 0 : 0;
      if (todayCount >= dailyLimit(env)) throw new HttpError(429, 'OTP login is busy right now. Please log in with Google or email.');

      const newCode = randomCode();
      const exp = now + ttlMs(env);
      await fs.commit([
        { op: 'set', path: `otps/${phone}`, data: { hash: await hashCode(env, phone, newCode), expiresAt: exp, tries: 0, sentAt: now, hour: { start: perPhone.start, count: perPhone.count + 1 } } },
        { op: 'set', path: `otpLimits/${ipKey}`, data: { start: perIp.start, count: perIp.count + 1 } },
        { op: 'set', path: 'otpLimits/global', data: { day: today, count: todayCount + 1 } },
      ], tx);
      code = newCode; expiresAt = exp;
    } catch (e) {
      await fs.rollback(tx);
      if (e.firestoreStatus !== 'ABORTED' || attempt === 3) throw e; // ABORTED = two requests at once
    }
  }
  return { sent: true, expiresAt, ...(await deliverOtp(env, fs, { phone, code, expiresAt })) };
}

export async function verifyOtp(env, fs, { phone, code }) {
  phone = cleanPhone(phone);
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) throw new HttpError(400, 'Please enter the 6-digit OTP');
  let verified = false;
  for (let attempt = 0; attempt < 4 && !verified; attempt++) {
    const tx = await fs.beginTransaction();
    try {
      const [cur] = await fs.getMany([`otps/${phone}`], tx);
      if (!cur || !cur.hash) throw new HttpError(400, 'Please request an OTP first');
      if (Date.now() > cur.expiresAt) throw new HttpError(400, 'OTP expired. Please request a new one.');
      if ((cur.tries || 0) >= MAX_TRIES) throw new HttpError(429, 'Too many wrong attempts. Please request a new OTP.');
      if (!safeEqual(await hashCode(env, phone, code), cur.hash)) {
        const tries = (cur.tries || 0) + 1;
        await fs.commit([{ op: 'update', path: `otps/${phone}`, data: { tries } }], tx);
        const left = MAX_TRIES - tries;
        throw new HttpError(left ? 400 : 429, left
          ? `Incorrect OTP. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`
          : 'Too many wrong attempts. Please request a new OTP.');
      }
      // One use only: the code and the admin's copy are removed
      await fs.commit([
        { op: 'update', path: `otps/${phone}`, data: { hash: '', expiresAt: 0 } },
        { op: 'delete', path: `otpRequests/${phone}` },
      ], tx);
      verified = true;
    } catch (e) {
      await fs.rollback(tx);
      if (e.firestoreStatus !== 'ABORTED' || attempt === 3) throw e;
    }
  }
  const uid = await phoneUserUid(env, '+91' + phone);
  return { token: await createCustomToken(env.FIREBASE_SERVICE_ACCOUNT, uid, { emulator: isEmulator(env) }) };
}
