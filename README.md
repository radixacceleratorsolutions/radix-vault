# Radix Vault

Storefront for Radix Vault, the trading card and games division of Radix Accelerator Solutions LLC. Sells One Piece Card Game booster boxes and sleeved booster packs (OP-14, OP-16, OP-17), with accounts, cart, stock and per-order limits, flat/free shipping, Stripe payments, and an admin page for fulfillment, prices and stock.

## Run locally
1. Install Node 20.6+ and run `npm install`.
2. `cp .env.example .env` and fill it in (Stripe test keys, a long random `JWT_SECRET`, admin email and password).
3. `npm start`, then open http://localhost:3000
4. In another terminal: `stripe listen --forward-to localhost:3000/webhook` and put the `whsec_...` value in `.env`.
5. Test card: 4242 4242 4242 4242, any future date, any CVC.

## Things to edit
- `config.json`: support email, shipping rate, free-shipping threshold, handling time, countries, return policy text.
- `products.json`: starting catalog. After the first run, price and stock live in `data.json` and are edited on the **Admin** page (log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`).
- Product photos: put files in `public/img/` and add `"image": "/img/op17-box.jpg"` to a product. Use your own photos or images you are licensed to use. Without an image, a set-coloured tile is shown.
- To add products (other games, trading cards, board games), copy an entry in `products.json` and give it a new `id`, `category` and `kind`. Delete `data.json` to re-seed in development.

## Payments
Checkout uses Stripe's hosted page, so card data never touches your server. In Stripe Dashboard > Settings > Payment methods, enable Cards, Apple Pay and PayPal. Apple Pay needs a live HTTPS domain registered with Stripe. PayPal availability depends on your account.
Sales tax: turn on Stripe Tax in the Dashboard, register where you collect, then set `STRIPE_TAX=on`.

## Go live
1. Deploy to a Node host (Render, Railway, Fly.io). Set all `.env` values as host environment variables, with `BASE_URL` set to your https address.
2. Add a Stripe webhook endpoint `BASE_URL/webhook` for: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
3. `data.json` is a simple file store. Use a host with a persistent disk, or move to Postgres/SQLite before real traffic.
4. Have counsel review the policy text and the independent-retailer disclaimer.
5. Nice to add next: email verification, password reset, rate limiting at the proxy, CAPTCHA on signup, and a backup of `data.json`.

## Put it on GitHub
```
git init && git add . && git commit -m "Radix Vault storefront"
git branch -M main
git remote add origin https://github.com/YOUR-ORG/radix-vault.git
git push -u origin main
```
`.env` and `data.json` are git-ignored.
