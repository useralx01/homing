# Homing

**Snap what you sell. AI hands it straight to the people already looking for it, with a PayPal button attached.**

Selling second-hand today is slow on both sides: the seller writes a listing and waits, the buyer browses for days, and then both text back and forth. Homing flips it: buyers say once what they're looking for (and what they care about), sellers take one photo, and the AI delivers the item to exactly the right people in a few seconds, each with a ready PayPal checkout. First to pay gets it.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

## How it works

1. **A buyer says what they want**, in their own words: *"A PS5 controller for my brother, white if possible, up to 40 €. Please no stick drift."*
   Gemini turns that into a request: the item, max price, city, and the things they want checked (`no stick drift`, `white colour`, …). Buyers opt in; nobody gets messaged who didn't ask.
2. **A seller takes one photo** and writes one line: *"PS5 controller, white, 35 €"*, plus optional details.
3. **Gemini reads the photo** (what it is, condition, visible facts and flaws) and **matches it against every open request**. For each match it writes:
   - one short personal message (because most people don't read more),
   - a fit score and a one-line reason,
   - an honest check of every point the buyer cares about: ✓ ok, ! warning, ? unknown.
4. **PayPal**: for every matched buyer the server creates a PayPal order (Orders v2, `intent: CAPTURE`) and attaches its checkout link. The buyer sees the photo, the short message, a **Details** section (their checklist + all item facts and flaws), and a **Pay with PayPal** button.
5. **First to pay wins**: when a buyer approves, the server captures the order, marks the item sold, and every other buyer sees "Sold to someone else" and is never charged. The seller's screen updates live.

## PayPal + AI, concretely

| Part | What is used |
|---|---|
| AI vision | Gemini (`gemini-3.5-flash-lite`, with automatic fallback to other Gemini models) reads the photo and the seller's words into structured facts and flaws |
| AI matching | Gemini scores every opt-in request, writes the one-line message and checks each buyer's "care about" list honestly |
| AI request parsing | Gemini turns a buyer's free text into item, max price, city and checklist |
| PayPal OAuth | `POST /v1/oauth2/token` (client credentials, cached) |
| PayPal Orders v2 | `POST /v2/checkout/orders` per matched buyer, with `payment_source.paypal.experience_context` (return/cancel URL, `PAY_NOW`, no shipping), optional `payee.email_address` so money goes straight to the seller's PayPal |
| PayPal capture | `POST /v2/checkout/orders/{id}/capture` on return; only the first approved order is captured |

## Run it

Requirements: Node 18+, a PayPal developer account (free sandbox) and a Gemini API key (free tier works).

```bash
git clone https://github.com/iamlicht1f1-maker/homing.git
cd homing
npm install
cp .env.example .env   # then fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, GEMINI_API_KEY
npm start
```

Open http://localhost:4321.

- **Sell**: add any photo + one line, press *Find the people looking*.
- **Who's looking**: 10 demo buyers are pre-loaded (Mara wants a white PS5 controller, Lea a film camera, Tim a road bike, …). Open anyone's inbox to see what they received.
- **I'm looking**: add yourself as a buyer in plain words.
- **Pay**: click *Pay with PayPal* and log in with a **PayPal sandbox personal account** (create one under *Testing Tools → Sandbox Accounts* in the PayPal developer dashboard). No real money moves.
- `POST /api/reset` restores the demo buyers.

### Settings (`.env`)

| Key | Meaning |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials |
| `PAYPAL_ENV` | `sandbox` (default) or `live` |
| `GEMINI_API_KEY` | Google AI Studio key |
| `GEMINI_MODEL`, `GEMINI_FALLBACKS` | Model and comma-separated fallbacks |
| `BASE_URL` | Public URL of the app (used for PayPal return links) |
| `CURRENCY` | Default `EUR` |

## Project layout

```
server.mjs        Express server: Gemini calls, matching, PayPal orders + capture
public/           index.html, app.css, app.js (no build step)
seed/wants.json   Demo buyers
data/             Runtime data and uploaded photos (git-ignored)
```

## What's next

- Buyers get the offer where they already are (email / push / chat), not only in the in-app inbox.
- Seller payouts through PayPal so each private seller is paid directly at scale.
- The same flow for small shops: one product photo reaches only people who asked for that thing. No ads, no spam.

## License

MIT, see [LICENSE](LICENSE).
