// HMI Fashion Store — shared configuration (public values only; no secrets here)
window.HMI_CONFIG = {
  firebase: {
    apiKey:            "AIzaSyBiYMzpLUWNDPIsdQ1UOjeAbDweX9Cv1GM",
    authDomain:        "hmi-fashion-store.firebaseapp.com",
    projectId:         "hmi-fashion-store",
    storageBucket:     "hmi-fashion-store.firebasestorage.app",
    messagingSenderId: "988891730362",
    appId:             "1:988891730362:web:40f2c9ee6774df53e24d83"
  },
  // Checkout server (Cloudflare Worker). Set this after deploying worker/ — see worker/README.md
  workerUrl: "https://hmi-checkout.hmi-fashion.workers.dev",
  // Login buttons. pinLogin: free mobile number + 4-digit PIN (needs the worker deployed).
  // phoneOtp: Firebase SMS OTP, costs money (Blaze plan), so it is off.
  pinLogin: true,
  phoneOtp: false,
  storeName: "HMI Fashion Store",
  whatsapp: "919560291565"
};
