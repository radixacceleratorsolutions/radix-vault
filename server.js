const express = require('express'), fs = require('fs'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET, ADMIN_EMAIL = '', ADMIN_PASSWORD = '', STRIPE_TAX, BASE_URL = 'http://localhost:3000', PORT = 3000 } = process.env;
if (!JWT_SECRET || !STRIPE_SECRET_KEY) throw new Error('Set JWT_SECRET and STRIPE_SECRET_KEY in .env');
const stripe = require('stripe')(STRIPE_SECRET_KEY);
const cfg = require('./config.json'), adminEmail = ADMIN_EMAIL.toLowerCase();
const DB = 'data.json';
const load = () => { const d = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { users: [], orders: [] }; d.products ??= require('./products.json'); return d; };
const save = d => fs.writeFileSync(DB, JSON.stringify(d, null, 1));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const session = u => ({ token: jwt.sign({ id: u.id, name: u.name, email: u.email }, JWT_SECRET, { expiresIn: '7d' }), name: u.name, admin: !!adminEmail && u.email === adminEmail });
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Please log in first.' }); }
};
const admin = (req, res, next) => auth(req, res, () => adminEmail && req.user.email === adminEmail ? next() : res.status(403).json({ error: 'Admins only.' }));
const tries = {};
const throttle = (req, res, next) => { const t = Date.now(), k = req.ip; tries[k] = (tries[k] || []).filter(x => t - x < 9e5);
  if (tries[k].length >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' }); tries[k].push(t); next(); };

// The admin account is created from .env, so nobody else can claim that email address
if (adminEmail && ADMIN_PASSWORD) {
  const d = load(); let u = d.users.find(u => u.email === adminEmail);
  if (!u) { u = { id: uid(), name: 'Admin', email: adminEmail }; d.users.push(u); }
  u.hash = bcrypt.hashSync(ADMIN_PASSWORD, 10); save(d);
}

const app = express();
app.set('trust proxy', 1);
app.use((q, r, n) => { r.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); n(); });

// Stripe webhook: the only place an order becomes "paid" and stock is reduced
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let e;
  try { e = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET); }
  catch { return res.sendStatus(400); }
  const s = e.data.object, d = load(), o = d.orders.find(o => o.id === s.metadata?.orderId);
  const paid = (e.type === 'checkout.session.completed' && s.payment_status === 'paid') || e.type === 'checkout.session.async_payment_succeeded';
  if (o && o.status === 'pending' && paid) {
    o.status = 'paid'; o.total = s.amount_total / 100; o.tax = (s.total_details?.amount_tax || 0) / 100;
    o.shipTo = s.shipping_details || s.collected_information?.shipping_details || null;
    o.items.forEach(i => { const p = d.products.find(p => p.id === i.id); if (p) p.stock = Math.max(0, p.stock - i.qty); });
    save(d);
  } else if (o && o.status === 'pending' && ['checkout.session.expired', 'checkout.session.async_payment_failed'].includes(e.type)) { o.status = 'expired'; save(d); }
  res.sendStatus(200);
});

app.use(express.json());
app.get('/api/config', (req, res) => res.json(cfg));
app.get('/api/products', (req, res) => res.json(load().products));

app.post('/api/register', throttle, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8)
    return res.status(400).json({ error: 'Enter a name, a valid email and a password of 8+ characters.' });
  const d = load();
  if (d.users.some(u => u.email === email.toLowerCase())) return res.status(400).json({ error: 'That email is already registered.' });
  const u = { id: uid(), name: String(name).slice(0, 60), email: email.toLowerCase(), hash: await bcrypt.hash(password, 10) };
  d.users.push(u); save(d); res.json(session(u));
});

app.post('/api/login', throttle, async (req, res) => {
  const u = load().users.find(u => u.email === (req.body.email || '').toLowerCase());
  if (!u || !(await bcrypt.compare(req.body.password || '', u.hash))) return res.status(401).json({ error: 'Wrong email or password.' });
  res.json(session(u));
});

app.get('/api/orders', auth, (req, res) => res.json(load().orders.filter(o => o.userId === req.user.id && o.status !== 'expired').reverse()));

// Prices, stock and limits are always read on the server, never trusted from the browser
app.post('/api/checkout', auth, async (req, res) => {
  const d = load(), items = [];
  for (const i of req.body.items || []) {
    const p = d.products.find(p => p.id === i.id), qty = i.qty | 0;
    if (!p || qty < 1) continue;
    if (qty > p.limit) return res.status(400).json({ error: `Limit ${p.limit} per order for ${p.setName} ${p.kind}.` });
    if (qty > p.stock) return res.status(400).json({ error: p.stock ? `Only ${p.stock} left of ${p.setName} ${p.kind}.` : `${p.setName} ${p.kind} is sold out.` });
    items.push({ p, qty });
  }
  if (!items.length) return res.status(400).json({ error: 'Your cart is empty.' });
  const subtotal = items.reduce((s, { p, qty }) => s + p.price * qty, 0);
  const ship = subtotal >= cfg.shipping.freeOver ? 0 : cfg.shipping.flat;
  const o = { id: uid(), userId: req.user.id, email: req.user.email, status: 'pending', date: new Date().toISOString(), subtotal, shipping: ship,
    items: items.map(({ p, qty }) => ({ id: p.id, name: p.name, qty, price: p.price })) };
  d.orders.push(o); save(d);
  try {
    // No payment_method_types set: Stripe shows cards, Apple Pay, PayPal etc. as enabled in your Dashboard
    const s = await stripe.checkout.sessions.create({
      mode: 'payment', metadata: { orderId: o.id }, customer_email: req.user.email,
      line_items: items.map(({ p, qty }) => ({ quantity: qty, price_data: { currency: 'usd', unit_amount: Math.round(p.price * 100), product_data: { name: p.name } } })),
      shipping_address_collection: { allowed_countries: cfg.shipping.countries },
      shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: ship ? 'Standard shipping' : 'Free shipping', fixed_amount: { amount: Math.round(ship * 100), currency: 'usd' } } }],
      ...(STRIPE_TAX === 'on' && { automatic_tax: { enabled: true } }),
      expires_at: Math.floor(Date.now() / 1000) + 1800,
      success_url: BASE_URL + '/#/success', cancel_url: BASE_URL + '/#/cart'
    });
    res.json({ url: s.url });
  } catch (err) { console.error(err.message); res.status(500).json({ error: 'Payment could not be started. Please try again.' }); }
});

// Admin: fulfill orders, set price and stock
app.get('/api/admin', admin, (req, res) => { const d = load(); res.json({ orders: d.orders.filter(o => ['paid', 'shipped'].includes(o.status)).reverse(), products: d.products }); });
app.post('/api/admin/ship/:id', admin, (req, res) => {
  const d = load(), o = d.orders.find(o => o.id === req.params.id); if (!o) return res.sendStatus(404);
  o.status = 'shipped'; o.tracking = String(req.body.tracking || '').slice(0, 80); save(d); res.json({ ok: 1 });
});
app.post('/api/admin/product/:id', admin, (req, res) => {
  const d = load(), p = d.products.find(p => p.id === req.params.id); if (!p) return res.sendStatus(404);
  const price = +req.body.price, stock = req.body.stock | 0;
  if (!(price > 0) || stock < 0) return res.status(400).json({ error: 'Enter a valid price and stock.' });
  p.price = price; p.stock = stock; save(d); res.json({ ok: 1 });
});

app.use(express.static('public'));
app.listen(PORT, () => console.log(`${cfg.brand} running at ${BASE_URL}`));
