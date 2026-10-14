# HMI Fashion Store — Go-live guide

Yeh guide store ko naye system par live karne ke liye hai. Steps isi order mein karein.
Har step ke baad ✅ laga lijiye.

**Kya kya chahiye:** Firebase Console access, Razorpay account (bana hua hai), ek free Cloudflare account, aur is repo ka Codespace.

---

## 1. Firebase Console (console.firebase.google.com → hmi-fashion-store)

### 1.1 Free Trial / Blaze (sirf Phone OTP ke liye)
- [ ] Left mein neeche **Upgrade** → Blaze → billing account mein **Free Trial** chunein ($300 credit, 90 din).
- [ ] Google Cloud Console → Billing → **Budgets & alerts** → ₹500 ka budget alert laga dein.
- Trial khatam hone par project apne aap free plan par aa jata hai. Tab Phone OTP band ho jayega, lekin **Google login, products, orders aur payment chalte rahenge**.

### 1.2 Login tareeke chalu karein
Authentication → **Sign-in method**:
- [ ] **Phone** → Enable
- [ ] **Google** → Enable (support email chunein)
- [ ] **Email/Password** → Enable (admin login ke liye)

Authentication → Settings → **Authorized domains**:
- [ ] `shop.hmitechnology.co.in` add karein

### 1.3 Admin account banayein
- [ ] Authentication → Users → **Add user** → apna email + ek naya mazboot password.
- [ ] Us user ka **User UID** copy karein.
- [ ] Firestore Database → **Start collection** → Collection ID: `admins` → Document ID: *(UID paste)* → field `email` (string) = apna email → Save.

> Purana admin password (`SECURITY_README.txt` wala) ab kisi kaam ka nahi rahega. Naya password kahin bhi code mein mat likhiye.

### 1.4 Service account key (checkout server ke liye)
- [ ] ⚙️ Project settings → **Service accounts** → **Generate new private key** → JSON file download hogi.
- Yeh file **bahut secret** hai. GitHub par kabhi upload mat karna. Step 2 ke baad delete kar dena.

---

## 2. Checkout server (Cloudflare Worker — free)

- [ ] dash.cloudflare.com par free account banayein.
- [ ] Codespace terminal mein (repo folder `hmi-fashion-store`):

```bash
cd worker
npx wrangler login                     # browser mein Cloudflare login
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT   # service account JSON ka poora content paste karein

npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET    # koi bhi lambi random line, Step 3.2 mein bhi yahi
npx wrangler secret put IMGBB_API_KEY              # naya ImgBB key (Step 4)
npx wrangler deploy
```

- [ ] Deploy ke baad ek URL milega, jaise `https://hmi-checkout.<naam>.workers.dev`.
- [ ] Browser mein `<URL>/health` kholein → `{"ok":true}` dikhna chahiye.
- [ ] `assets/config.js` mein `workerUrl: "<URL>"` likhein.

---

## 3. Razorpay (dashboard.razorpay.com)

### 3.1 Keys
- [ ] Upar se **Test Mode** chalu karein → Settings → **API Keys** → Generate → Key ID + Secret → Step 2 ke secrets mein daalein.
- [ ] Settings → **Payment capture** → *Automatic* (default yahi hota hai).

### 3.2 Webhook (customer ne pay karke browser band kar diya toh bhi order ban jaye)
- [ ] Settings → **Webhooks** → Add new webhook
  - URL: `<worker URL>/razorpay/webhook`
  - Secret: wahi jo `RAZORPAY_WEBHOOK_SECRET` mein daala
  - Events: `payment.captured`, `order.paid`

### 3.3 Live karna (testing ke baad)
- [ ] KYC poora hone par **Live Mode** keys banayein.
- [ ] `npx wrangler secret put RAZORPAY_KEY_ID` aur `RAZORPAY_KEY_SECRET` dobara chalakar live keys daalein.
- [ ] Live mode mein bhi webhook (3.2) dobara add karein.

---

## 4. ImgBB (product photos)
Purani ImgBB key public ho chuki thi.
- [ ] api.imgbb.com → apne account mein naya key banayein → Step 2 mein `IMGBB_API_KEY`.
- [ ] Purana key delete kar dein.

---

## 5. Store live karna (yeh steps ek saath, 10 minute ke andar)

1. [ ] `ecommerce-rebuild` branch ko `main` mein merge karke push karein → GitHub Pages par naya store aur admin aa jayega.
2. [ ] **Turant** Firestore rules publish karein:
   - Firebase Console → Firestore → **Rules** → `firestore.rules` file ka poora content paste → **Publish**
   - *(ya terminal mein: `npx firebase login` → `npm run rules:deploy`)*
3. [ ] `https://shop.hmitechnology.co.in/admin.html` → Step 1.3 wale email/password se login.
4. [ ] **💾 Import / Backup** → **Import karo** → purane products aur categories naye system mein aa jayenge.
5. [ ] **👗 Products** → har product ka asli stock bhar dein (jinka stock pehle likha nahi tha unpe "∞ track nahi" dikhega).
6. [ ] **💳 Payment & Shipping** → shipping / COD settings check karke Save.

## 6. Test order (Razorpay test mode mein)
- [ ] Store kholein → product cart mein → checkout → apne phone number se OTP login.
- [ ] Address → Pay Online → Razorpay test card `4111 1111 1111 1111`, koi bhi future date, CVV `123`.
- [ ] Order "My Orders" mein dikhe, admin panel mein 🔔 naya order aaye, stock kam ho.
- [ ] Admin se status Confirmed → Shipped (courier + AWB daalein) → customer ke "My Orders" mein dikhe.
- [ ] Ek COD order bhi try karein.
- Sab theek ho toh Step 3.3 se live keys lagayein. 🎉

---

## 7. Mobile OTP login (bina SMS gateway — admin WhatsApp par OTP bhejta hai)

Customer number daalta hai → OTP admin panel ke **🔐 Login OTPs** mein aata hai → admin **📲 Send on WhatsApp** dabata hai → customer OTP daal kar login.

Order zaroori hai — pehle server aur rules, phir website:
- [ ] Codespace terminal: `npx firebase login` → `npm run rules:deploy` (naye rules: sirf admin OTP list dekh sake)
- [ ] `cd worker && npx wrangler deploy` (naye `/auth/otp/send` aur `/auth/otp/verify` routes)
- [ ] Browser mein `<worker URL>/health` → `{"ok":true}`
- [ ] Ab website push/deploy karein.
- [ ] Test: apna number daal kar OTP maangein → admin panel mein dikhega → WhatsApp se bhejein → login.

Settings `worker/wrangler.toml` mein: `OTP_TTL_MINUTES` (OTP kitni der chale, abhi 10), `OTP_DAILY_LIMIT` (din mein max OTP, abhi 300).
Baad mein SMS gateway lagana ho to sirf `worker/src/otp.js` ka `deliverOtp()` badalna hai.

## Developer notes
- `npm test` — security rules + checkout server ke saare tests (local emulator par, live data nahi chhoota).
- Local testing: `npm run emulators`, `node tests/dev-seed.mjs --catalogue`, `node tests/dev-worker.mjs`, `python3 -m http.server 5500`,
  phir `http://localhost:5500/index.html?emulator=1` aur `admin.html?emulator=1` (admin@test.local / test1234).
- Prices aur charges sirf `assets/pricing.js` mein calculate hote hain; store aur checkout server dono yahi file use karte hain.
