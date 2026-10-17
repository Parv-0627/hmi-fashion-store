# HMI Fashion Store

Live: https://shop.hmitechnology.co.in · Admin: /admin.html

- Store: `index.html` + `assets/store.js`
- Admin: `admin.html` + `assets/admin.js`
- Checkout server: `worker/` (Cloudflare Worker)
- Database rules: `firestore.rules`

Go-live aur setup ke steps: [SETUP.md](SETUP.md)

Developer note: `index.html` and `admin.html` load `assets/*.js?v=YYYYMMDDx`. Change that version whenever a JS file changes, so phones don't keep running an old cached copy.
