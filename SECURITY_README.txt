
=======================================================
  HMI FASHION STORE — SECURITY FIX GUIDE
=======================================================

✅ FIX 1: ADMIN PAGE PASSWORD PROTECTION
-----------------------------------------
admin.html mein login screen add ho gayi hai.
  Username: Parvezmalik
  Password: Parvez@8055

Features:
  • Password SHA-256 hash mein store hai (plain text nahi)
  • 5 galat attempts ke baad 15 min lock
  • Session-based (browser close = logout)
  • Logout button topbar mein hai

GitHub par upload karo — done!


✅ FIX 2: FIREBASE SECURITY RULES
-----------------------------------
Abhi Firebase ka database OPEN hai — koi bhi read/write kar sakta hai.
Yeh rules lagao:

STEPS:
  1. https://console.firebase.google.com kholo
  2. "hmi-fashion-store" project select karo
  3. Left menu: Firestore Database > Rules tab
  4. "firebase_security_rules.txt" ka content paste karo
  5. "Publish" button click karo

Rules kya karenge:
  ✓ Customer orders de sakenge (create allowed)
  ✓ Products website par dikhenge (read allowed)
  ✗ Koi bhi orders dekh/delete nahi kar sakta
  ✗ Koi bhi products directly change nahi kar sakta


✅ FIX 3: GITHUB TOKEN
------------------------
GitHub ne already alert kar diya — token leaked tha.

STEPS:
  1. https://github.com/settings/tokens kholo
  2. Leaked token revoke/delete karo
  3. NAYA token banao (agar zarurat ho)
  4. Token KABHI bhi HTML/JS file mein mat daalo
  5. Agar sirf products.js manually update karte ho
     toh token ki zarurat hi nahi hai!

=======================================================
