// Runs the checkout worker locally against the Firebase emulators, with a fake
// Razorpay/ImgBB API. For local testing only.
//   node tests/dev-worker.mjs   ->  worker on http://127.0.0.1:8787
import { createServer } from 'node:http';
import worker from '../worker/src/index.js';

const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/orders') {
      const o = JSON.parse(body);
      return res.end(JSON.stringify({ id: 'order_dev_' + Date.now(), amount: o.amount, currency: 'INR', receipt: o.receipt }));
    }
    if (req.url.startsWith('/1/upload')) return res.end(JSON.stringify({ success: true, data: { url: 'https://picsum.photos/seed/' + Date.now() + '/600/800' } }));
    res.statusCode = 404; res.end('{}');
  });
}).listen(8788, '127.0.0.1');

const ENV = {
  FIREBASE_PROJECT_ID: 'hmi-fashion-store', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085', AUTH_EMULATOR: 'true',
  RAZORPAY_KEY_ID: 'rzp_test_dev', RAZORPAY_KEY_SECRET: 'rzp_secret', RAZORPAY_WEBHOOK_SECRET: 'wh_secret',
  RAZORPAY_API_BASE: 'http://127.0.0.1:8788', IMGBB_API_KEY: 'dev', IMGBB_API_BASE: 'http://127.0.0.1:8788',
  ALLOWED_ORIGINS: 'http://localhost:5500,http://127.0.0.1:5500',
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks);
  const r = await worker.fetch(new Request('http://127.0.0.1:8787' + req.url, { method: req.method, headers: req.headers, body }), ENV);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, '127.0.0.1', () => console.log('dev worker on http://127.0.0.1:8787'));
void fake;
