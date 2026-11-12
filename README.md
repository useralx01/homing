# Homing

**Sell and buy in the blink of an eye.**

Snap what you sell. AI checks the photo and hands it to people who are already looking for it. The buyer pays with PayPal. Tracking runs by itself.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

Live demo: https://useralx01.github.io/homing/ (PayPal sandbox)
Demo video: https://youtu.be/nZrHLgIK-b4

## What it is

Selling second-hand is slow. The seller writes a listing and waits. The buyer browses for days. Then both text back and forth.

Homing turns it around. Buyers say once what they are looking for. Sellers take one photo. The AI sends the item to the right people in seconds, each with a ready PayPal checkout. The first to pay gets it.

## How it works

1. **Sign in with PayPal.** One click, no new password. (Judges without a PayPal sandbox login can use "demo sign-in", a made-up person with a made-up address.)
2. **Sell.** Take a photo and write one line, like "Game controller, white, 35 EUR". The AI reads the photo (what it is, condition, flaws), then matches it against every open request. For each match it writes one short message, a fit score, and an honest check of what the buyer cares about (ok, warning, unknown).
3. **Buy.** Say in your own words what you want ("a white game controller, up to 40 EUR, no stick drift"). When a match shows up you see the photo, the message, the details, and a **Pay with PayPal** button. The first buyer to pay gets the item. Everyone else sees "Sold to someone else" and is never charged.
4. **Track.** After payment the seller gets a shipping label and a parcel number. The tracking status updates by itself, and the number is sent back to PayPal so the buyer sees it there too. Buyers and sellers can leave a review.

## PayPal and AI: what is used

Only what the code actually calls:

| Part | What it does |
|---|---|
| Log in with PayPal (OpenID Connect) | `/signin/authorize` with scope `openid profile email address`, then `POST /v1/oauth2/token` (authorization code) and `GET /v1/identity/openidconnect/userinfo` |
| OAuth client credentials | `POST /v1/oauth2/token` for server calls |
| Orders v2 | `POST /v2/checkout/orders` (intent `CAPTURE`) for each matched buyer, optional payee so the money goes to the seller |
| Capture | `POST /v2/checkout/orders/{id}/capture` when the buyer returns. Only the first approved order is captured. |
| Refund | `POST /v2/payments/captures/{id}/refund` if a second payment slips through |
| Shipment tracking | `POST /v2/checkout/orders/{id}/track` adds the parcel number to the PayPal order |

**AI:** Google Gemini (default `gemini-3.5-flash-lite`, with automatic fallback to other Gemini models). It does three jobs:
- reads the seller's photo and text into facts and flaws,
- turns a buyer's free text into a request (item, max price, city, checklist),
- scores each match and writes the short message and the checklist result.

Shipping uses DHL if `DHL_API_KEY` and `DHL_GKP_USER` are set. Otherwise it runs in a sandbox mode with test parcel numbers (no real postage).

## Run it locally

You need:
- **Node 22.5 or newer.** The app uses the built-in `node:sqlite`. Tested on Node 24.
- A free PayPal developer account with a sandbox app (client id and secret).
- A Gemini API key (Google AI Studio, free tier works).

```bash
npm install
cp .env.example .env    # then fill in the values
npm start
```

Open http://localhost:4321 (change with `PORT`).

Variable names in `.env`:

| Name | Meaning |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal sandbox app credentials |
| `PAYPAL_ENV` | `sandbox` (default) or `live` |
| `GEMINI_API_KEY` | Gemini key |
| `GEMINI_MODEL`, `GEMINI_FALLBACKS` | Model and comma-separated fallbacks |
| `PORT` | Default `4321` |
| `BASE_URL` | Public URL of the app, used for PayPal return links |
| `CURRENCY` | Default `EUR` |

Optional: `DHL_API_KEY`, `DHL_GKP_USER`, `DATA_DIR`, `DB_FILE`, `TRUST_PROXY`, `TRACK_DEMO_MINUTES`, `AUTH_BOUNCE`, `ADMIN_SECRET`, `DEBUG`.

For the PayPal login to work, add `BASE_URL/auth/paypal/return` as a return URL in your PayPal sandbox app. To pay, use a **PayPal sandbox personal account** (Developer Dashboard, Testing Tools, Sandbox Accounts). No real money moves.

## Tests

```bash
node --test test/security.test.mjs
```

33 tests, all passing (about 17 seconds). The test starts its own server on a free port with a temporary data folder, so your data is not touched. The payment tests call the real PayPal sandbox, and the sell/buy tests need Gemini, so both need your `.env` filled in.

## Project structure

```
server.mjs     Express server: Gemini, matching, PayPal login, orders, capture, tracking
public/        The web app (plain HTML, CSS, JS, no build step) and legal pages
seed/          Demo users, buyers and listings
test/          Tests and test photos
data/          SQLite database and uploaded photos (created at run time, git-ignored)
```

Stack: Node, Express, SQLite.

## License

MIT, see [LICENSE](LICENSE).
