# Legal pages: how to wire them in

**This is not legal advice. Have a lawyer check everything before going live.**

New pages are in `public/legal/`, English and German on one page. They show the browser's language, and the top switch changes it (`?lang=de` / `?lang=en`). They store nothing on the device. Without JS, both languages show.

- `index.html` lists all pages
- `impressum.html` (§ 5 DDG)
- `terms.html` (AGB, version `2026-11-11`)
- `privacy.html` (art. 13 GDPR, including cookies and storage)
- `refunds.html`, `buyer-protection.html`, `seller-rules.html`, `report.html`
- shared files: `legal.css` and `legal.js`

The sources are in `scratchpad/legal-src/*.html`. To rebuild with the shared header and footer, run `node build.mjs`. You can also edit the built files directly.

## Licht must fill in

Search the pages for `class="ph"`. They show as blue dashed placeholders.

- `[Full name]` / `[Vollständiger Name]`
- `[Street and number]`, `[ZIP City]`
- `[Email]` (the contact and DSA contact point), `[Report email]` (can be the same)
- `[Phone]`: the law needs a second fast contact channel besides email. A phone number or a contact form works. If you have neither, add a contact form.
- `[VAT ID, if any]`: delete that section if you have none.
- `[Hosting provider, address, country]`: right now the app runs on your PC. Fill this in when it's on a real host, and sign a data processing agreement (DPA, AVV) with that host.
- `[Data protection authority of the operator's state]`: for example, Berlin is the BlnBDI, www.datenschutz-berlin.de.

## Must fix before going live (real money)

1. **Payments go to the Homing account, not to the seller.** `purchaseUnit()` only sets `payee` when `seller.paypal` exists, and nothing ever sets it. The Terms and the refund page say "the money goes to the seller's PayPal account, Homing holds no money". For the live version, use PayPal's marketplace setup (PayPal Complete Payments / Multiparty, where sellers are onboarded and `payee.merchant_id` is set). Otherwise Homing would be collecting money for other people, which in Germany may need a payment licence (ZAG, from BaFin). Sandbox is fine for the hackathon.
2. **Self-host the fonts.** `index.html` loads from `fonts.googleapis.com`, which sends the user's IP to Google (LG München I, 20.01.2022, 3 O 17493/20). The privacy page already says the fonts are self-hosted. Put `Inter-var.woff2` and `InterTight-var.woff2` in `public/fonts/` (for example from the npm packages `@fontsource-variable/inter` and `@fontsource-variable/inter-tight`). Add `@font-face` rules in app.css and remove the three Google `<link>` lines. `legal.css` already points at `/fonts/Inter-var.woff2` and `/fonts/InterTight-var.woff2`; until the files exist, the console shows two 404s and the pages fall back to system fonts.
3. **Real DHL:** the privacy page says no data goes to DHL while parcels are sandbox parcels. Once real labels are booked, the text that's already there applies.

## App changes (small)

### 1. Footer links
In the sidebar (`index.html`, inside `<nav class="side">`, after `.side-foot`):
```html
<p class="side-legal"><a href="/legal/terms.html">Terms</a> · <a href="/legal/privacy.html">Privacy</a> · <a href="/legal/impressum.html">Impressum</a> · <a href="/legal/index.html">More</a></p>
```
On sign-in (under `.fine` in `.pp-in`):
```html
<p class="fine legal">By continuing you accept the <a href="/legal/terms.html">Terms</a> and the <a href="/legal/seller-rules.html">seller rules</a>. See how we use your data in the <a href="/legal/privacy.html">Privacy policy</a>. <a href="/legal/impressum.html">Impressum</a></p>
```
On the phone (no sidebar), add the same link row at the bottom of Home (under `.links`) and on My stuff. The Impressum must be reachable from every page in one or two taps.

CSS: `.side-legal,.fine.legal{font-size:12px;color:var(--muted)} .side-legal a,.fine.legal a{color:var(--muted)}`

### 2. Buy sheet line (`app.js`, `sb.innerHTML`, after the `#readIt` label)
```html
<p class="fine">By buying you accept the <a href="/legal/terms.html" target="_blank">Terms</a>. Private sale: no 14-day return right. <a href="/legal/refunds.html" target="_blank">Refunds</a></p>
```
The law (Art. 246d EGBGB) requires telling buyers that consumer protection rules don't apply when the seller is private. The line above covers that. When business sellers exist, show "Business seller · 14-day withdrawal" instead.

### 3. Post line (Sell form, above `#post`)
```html
<label class="check"><input type="checkbox" id="sAccept"><span><b>I accept the Terms and the seller rules</b><small>Private seller · my own item · real photo · <a href="/legal/seller-rules.html" target="_blank">rules</a></small></span></label>
```
Add it to the `miss` check so Post stays disabled until it's ticked. Send `accept: true` with the form.

### 4. Store which terms were accepted
- server.mjs: add `const TERMS_VERSION = '2026-11-11';`
- At sign-in (PayPal return and demo): `u.terms = { version: TERMS_VERSION, at: Date.now() }`. The sign-in line from step 1 is the acceptance.
- `/api/sell`: require `q.body.accept === 'true'`. Store `l.accepted = { version: TERMS_VERSION, at: Date.now(), private: true }`.
- `/api/listings/:id/pay`: store `buyerAccepted: { version, at }` with `l.capture` in `markSold`.
- Add `termsVersion` to `/api/meta`. If `me.terms?.version !== meta.termsVersion`, show a one-time "Updated terms: accept" sheet before Sell or Buy (Terms section 15).

### 5. Cookie / storage notice: none needed
We checked against § 25 TDDDG (formerly TTDSG). It's used:
- `homing_sid`: login cookie, httpOnly, 30 days
- `homing.user`: localStorage with id, name, fullName, country, avatar, for the first paint
- `homing.seen.<id>`: localStorage, which sales were already announced
- `homing.intro`: sessionStorage, intro played

All of these serve a service the user asked for, so they're exempt under § 25(2) Nr. 2 TDDDG. No banner is needed. The privacy page section 7 lists them.

The banner stays unnecessary only while there's no analytics, no ads, no third-party embeds and no Google Fonts (see must-fix 2). If you add any storage key, add it to privacy section 7.

### 6. "Report this item" (DSA art. 16)
- Item page (other people's items) and person page: a small text button `Report` that opens a sheet with reasons: illegal item · banned item · fake/stolen · wrong photo · fraud · abusive review · other. Add a text field (500 chars), an optional email for people who aren't signed in, and a checkbox "I believe this report is correct and complete".
- Server: `POST /api/reports` with `{ kind: 'listing'|'user'|'review', id, reason, text, email? }`. Store a row of kind `reports` with `status: 'open'` and `at`, and rate-limit it. Email or log it to you.
- The person who decides must send the poster a short reason (art. 17 statement of reasons: what, why, which rule, how to object). Email is fine. Keep reports for 1 year after the decision.

### 7. Account deletion (GDPR art. 17)
On My stuff, a "Delete my account" button (red text) with a confirm step. It calls `DELETE /api/me`:
- Refuse while a deal from the last 30 days isn't delivered yet ("finish your open deals first").
- Delete the avatar file, the photos of open or deleted listings, the open listings, wants and sessions, and the reviews and replies this user wrote.
- For sold deals: keep `l.capture`, `l.ship`, `l.shipment` (needed for 3 years, see privacy section 8). Replace the user record with `{ id, deleted: true, at }`, and show "Former member" where the name was.
- Clear the cookie and `localStorage` (`homing.user`, `homing.seen.*`).

### 8. Data export (GDPR art. 15/20)
On My stuff, a "Download my data" link to `GET /api/me/export`. It sends JSON with `content-disposition: attachment; filename=homing-data.json`. Contents: the user record (without the session data), their listings with photo URLs, wants, purchases and sales (including shipping and tracking), the reviews they wrote and got, and their reports.

### 9. Point old links to the new pages
- `public/privacy.html` → `/legal/privacy.html`
- `public/terms.html` → `/legal/terms.html`

Replace each old file's body with `<meta http-equiv="refresh" content="0; url=/legal/privacy.html">` (and the terms one the same way), or add `app.get('/privacy.html', (q,s)=>s.redirect(301,'/legal/privacy.html'))`.

- GitHub Pages (`useralx01.github.io/homing/privacy.html` and `terms.html`, registered in the PayPal "Log in with PayPal" settings): copy `public/legal/*` to gh-pages `legal/`, then make the old privacy/terms there point to `legal/privacy.html` and `legal/terms.html`. Ask before pushing. You don't need to change the URLs in the PayPal dashboard.
- On gh-pages, `/logo-blue.svg` and the `/` back link are root-absolute. Copy `logo-blue.svg` too, or fix the paths there.

### 10. Small things
- Age: Terms say 18+ (Gemini API terms forbid services likely used by under-18s). There's nothing to do in code; it's covered by the sign-in line.
- Business sellers: the app has no business toggle, so the Terms say "until the business setting is live, only private sellers may sell". When you add it (a "I sell as a business" switch with name, address, withdrawal text, and a "Business seller" label on items), delete that line in `terms.html` (section 3, EN and DE).
- Ship deadline: the pages say **3 working days**. The app shows no deadline. Optionally, show "Ship by <date>" on the Ship page.
- Price includes shipping: the app has no shipping field, so the pages say the price is the total and the seller pays postage. You could add "incl. shipping" next to prices.
- A "Use where I am" location goes to Nominatim. That's already covered in privacy section 3.

## Decisions made

- Ship within 3 working days. Return deadline 14 days. Seller answers within 3 days (a request, not a hard rule).
- Retention: finished deals for 3 years after the end of the year (normal limitation period), at most 10 years if tax law requires it. Reviews are deleted with the account.
- Terms changes need active acceptance in the app. No "silence = consent" (BGH XI ZR 26/20, 2021).
- No consumer arbitration: "not willing and not obliged". § 36 VSBG exempts businesses with 10 or fewer employees from the willingness statement, so saying it is safe and simple.
- No ODR link: the EU ODR platform closed on 20 July 2025 (Reg. (EU) 2024/3228).
- DSA: the DSA articles on online platforms (art. 20 internal complaint system, art. 24 transparency reports, art. 30 trader checks) don't apply to micro and small companies (art. 19, art. 29). Still required for us: art. 11/12 contact points, art. 14 rules in the terms, art. 16 notice and action, art. 17 statement of reasons, art. 18 reporting threats to life. We still offer a simple "object by email" process.
- Art. 246d EGBGB (marketplace info): ranking explained in Terms section 12, private/business status in Terms section 3 and the buy line.
- DAC7/PStTG: a seller is reported once they make **30 or more** sales or receive **€2,000 or more** in a year (exempt only if fewer than 30 AND less than €2,000, § 4(5) PStTG). The deadline is 31 January. Sellers who don't hand over their details after two reminders must be blocked (§ 23 PStTG). The app doesn't count this yet. Add counting before going live.

## Uncertain

- Whether the Gemini key stays covered by Google's EEA rule ("Paid Services data terms apply to all services" for EEA users, terms of 23 Mar 2026). The privacy page relies on it. If the key is from a non-EEA account, enable billing (paid tier).
- Which Google entity is the contracting party for the Gemini API in the EEA. The page names Google Ireland Ltd plus Google LLC. Check this in the AI Studio / Cloud account.
- I could not open PayPal's Acceptable Use Policy (PayPal blocks bots), so the banned list was built from secondary quotes plus common law. Open https://www.paypal.com/de/legalhub/paypal/acceptableuse-full yourself and compare it with seller-rules section 2.
- The PayPal links (`/de/legalhub/paypal/privacy-full`, `/de/legalhub/paypal/acceptableuse-full`, `/de/webapps/mpp/ua/buyer-protection`) were not opened (bot block). Click them once.
- PayPal case deadlines (180 days to report, 20 days to escalate) come from PayPal DE help pages and press, not the full user agreement.
- Risk of loss for lost parcels in private sales (§ 447 BGB) is left to "law and PayPal rules". A lawyer may want this to be explicit.

## Sources

- § 5 DDG: https://www.gesetze-im-internet.de/ddg/__5.html
- § 36 VSBG: https://www.gesetze-im-internet.de/vsbg/__36.html
- ODR shutdown: https://www.taylorwessing.com/en/insights-and-events/insights/2025/01/abolition-of-the-odr-platform , https://cms.law/en/deu/legal-updates/the-odr-platform-is-closing-what-businesses-need-to-know , https://paytechlaw.com/en/the-end-of-the-odr-platform/
- DSA art. 19 / 29: https://www.springlex.eu/en/packages/dsa/dsa-regulation/article-19/ , https://www.springlex.eu/en/packages/dsa/dsa-regulation/article-29/ , https://www.beuc.eu/sites/default/files/publications/ConsumerPro_DSA-complement_to_TBD_2023.pdf
- PStTG § 4, § 13, § 22, § 23: https://www.gesetze-im-internet.de/psttg/ ; https://www.finanzamt.nrw.de/steuerinfos/unternehmen/plattformen-steuertransparenzgesetz ; https://www.ebay.de/help/selling/selling/eu-dac7-und-das-plattformensteuertransparenzgesetz-meldepflichten?id=5394
- Art. 246d § 1 EGBGB: https://www.gesetze-im-internet.de/bgbeg/art_246d__1.html
- § 25 TDDDG: https://www.gesetze-im-internet.de/ttdsg/__25.html ; GDD Praxishilfe: https://gdd.de/wp-content/uploads/2024/05/GDD-Praxishilfe-DS-GVO-ePrivacy-und-Datenschutz-beim-Onlineauftritt.pdf ; https://www.e-recht24.de/datenschutz/12834-tdddg.html
- Gemini API terms (23 Mar 2026, EEA clause, 18+): https://aistudio.google.com/docs/terms
- UK adequacy renewed to 27 Dec 2031: https://www.hunton.com/privacy-and-cybersecurity-law-blog/european-commission-renews-uk-data-adequacy-decisions , https://www.theregister.com/2025/12/22/eu_uk_data_adequacy/
- PayPal merchant site needs (privacy + terms): https://developer.paypal.com/braintree/articles/risk-and-security/compliance/ecommerce-website-requirements
- PayPal AUP (secondary, page blocked): https://www.paypal.com/us/smarthelp/article/FAQ940 , https://conductatlas.com/platform/paypal/paypal-acceptable-use-policy/prohibited-activities-list/
- PayPal Buyer Protection DE (180 days, 20 days): https://www.paypal.com/de/webapps/mpp/ua/buyer-protection , https://www.paypal.com/de/cshelp/article/HELP364 , https://utopia.de/ratgeber/paypal-kaeuferschutz-das-solltest-du-wissen_296390/
