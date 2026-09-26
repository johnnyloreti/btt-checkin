# btt-checkin STATUS

**Last updated:** 2026-09-07
**Build order (§10):** steps 1 through 7 complete. Deployed 2026-09-07 at `https://btt-checkin.black-term-300b.workers.dev` with the cron trigger active. Acceptance test passed the same day: kiosk check-in, staff roster, and a rollup that filled all five GHL fields. Logo in place. Live at `https://checkin.bttbridgewater.com` via the Netlify proxy since 2026-09-07; both cron jobs confirmed running on their own.

## What is built

| Piece | Where | Notes |
|---|---|---|
| Worker entry, schedule validation, cron dispatch | `src/index.js`, `src/cron.js` | Bad `schedule.json` fails the deploy, not a check-in |
| Router and all routes from §7 | `src/app.js` | Errors return JSON, never a stack |
| D1 schema | `src/db/schema.sql` | Idempotent, safe to re-run |
| Schedule | `schedule.json`, `src/schedule.js` | BOM and CRLF tolerated |
| Roster sync from GHL, every 30 min | `src/roster.js`, `src/ghl.js` | Emptiness guard, degraded and failed logging |
| Kiosk page | `public/index.html`, `public/search.js` | One file, no framework, offline queue |
| Public API with opaque ids and rate limits | `src/ids.js`, `src/checkin.js`, `src/classes.js`, `src/ratelimit.js` | 60/min/IP |
| Staff page and API | `public/staff.html`, `public/staff-login.html`, `src/staff.js`, `src/staff-auth.js` | 12 h cookie, login 5/min/IP |
| Nightly rollup push to GHL, 03:00 ET | `src/rollup.js` | The only GHL write |
| Waiver prompt (§15.1) | `src/waiver.js`, `src/fields.js` | Field check on every roster sync; nudge failures in `sync_log` |
| Stripe tab (§15.2) | `src/promotions.js` | Eligibility from attended classes since the last stripe |
| Drink tab (§15.3), Phase 1 | `src/tab.js`, `src/pin.js`, `src/purchases.js`, `src/closeout.js`, `public/pin.html`, `tab-items.json` | Kiosk drink row, PIN by texted link, staff Tab view, review and charge through GHL invoices with saved-card auto-pay |
| Tests | `test/` | `npm test`: 243 unit tests, no network. `npm run test:browser` needs Playwright |

## Decisions made without you (confirm or say otherwise)

1. **Check-in window.** 3 hours before class start to 3 hours after, per Johnny on 2026-09-16 ("wide and easy"). Set with `CHECKIN_EARLY_MIN` and `CHECKIN_LATE_MIN` in `wrangler.toml`, in minutes; edit and deploy to change, no code change needed. `src/classes.js` holds the defaults. At this width most of a day's classes sit in the window together and the program tag picks one. The tradeoff Johnny accepted: someone can check into a class up to 3 hours after it started, so a late tap can land on a class that already finished. Narrow the late side if attendance data ever needs to be tighter.
2. **Full names on tiles.** Per Johnny on 2026-09-06, tiles and the confirm screen show first and last name. The public roster JSON therefore carries last names. It still carries no contact ids, status, or contact details, and it is rate-limited, but anyone who finds the URL can list member names. If that ever matters, the fix is a server-side search route.
3. **Voided rows come back.** If staff remove someone and that person then checks in again for the same class, the row is set back to attended. Staff see the new tap time.
4. **Open mat.** "Check in anyway" records `open mat / unscheduled` at `T00:00` for that date, once per member per day.
5. **Inactive members** appear on the kiosk and can check in. The record carries `status_at_checkin = inactive`. Staff see an inactive tag on the roster row.
6. **Backdating.** The kiosk accepts a queued check-in up to three days back and refuses anything older, so a tap stranded on an iPad that lost wifi cannot surface weeks later. Staff reach back thirty days, so a class nobody tapped for can still be filled in. `KIOSK_BACKDATE_DAYS` and `STAFF_BACKDATE_DAYS` in `wrangler.toml`, in whole days.
7. **Rollup week** is Monday to Sunday in ET. At Monday 03:00 the week count resets to zero for everyone.
8. **One cron trigger.** A single every-30-minutes schedule runs the roster sync on every tick and the rollup on the tick that is 03:00 ET, whatever DST is doing. One trigger because Workers Free allows 5 per account and btt-ops uses some of them.
9. **Compatibility date** is 2026-08-01. Wrangler is pinned to the 4.129 line.

## Things the brief got wrong or left open

- The staff mock shows "Sat Sep 6". 2026-09-06 is a Sunday. The code uses real weekdays.
- Class durations (30 / 45 / 60 / 60) are still the inferred values. They affect nothing today, since the window is computed from the start time alone. Confirm them anyway so `schedule.json` is true.
- Founding members without a `program:*` tag land in Adult and are listed by name in the roster sync log detail. Setup task 4 clears that list.
- A `program:*` tag alone makes a member. Founding and Foundations tags still work. A misspelled program tag is flagged in the sync output.
- Paying parents who do not train keep `founding-member` and get `program:none`. That removes them from the kiosk, the staff search, and the flagged list.

## Your setup tasks before first deploy (§11)

1. GHL: mint the `BTT Check-In` Private Integration with exactly `contacts.readonly`, `contacts.write`, `locations/customFields.readonly`.
2. GHL: create five contact custom fields with these exact keys: `attendance_last`, `attendance_30d`, `attendance_lifetime`, `attendance_week`, `attendance_class_count_label`. Text type is fine for all five.
3. GHL: tag every `founding-member` contact with one `program:*` tag.
4. Logo is in place at `public/logo.png`. The file name must stay lowercase; Cloudflare serves `logo.PNG` and `logo.png` as different files.
5. Pick a 4-digit staff PIN and a long random `ID_SALT` (32 or more characters). Changing either later signs all staff out.

## V2: waiver prompt (§15.1)

Built 2026-09-07. Needs, in this order:

1. GHL: make sure a signed waiver puts the tag `waiver-signed` on the **student's** contact (for kids, the child, not the parent). If your tag is named differently, change `WAIVER_TAG` in `wrangler.toml`.
2. GHL: create a contact custom field with key `checkin_last_at` (text). Or change `WAIVER_FIELD`.
3. GHL: a workflow with trigger "custom field checkin_last_at changed", condition "tag waiver-signed is absent", action: send the waiver text or email.
4. `public/waiver-qr.png`: the waiver QR image, lowercase name. Without it the success screen shows the line and no code.
5. D1 migration, once, before the deploy:
```
wrangler d1 execute btt-checkin --remote --file=src/db/migrations/002_waiver.sql
```
6. `wrangler deploy`, then one sync so the waiver flags fill in.

What happens: a member without the tag still checks in. The success screen adds "One thing before class: sign the waiver" with the QR and stays up 12 seconds. The staff roster row shows "no waiver". The Worker writes `checkin_last_at` to that contact right away (the same allowed write as the rollup) and your GHL workflow sends the message. The Worker never sends messages itself. Empty `WAIVER_TAG` turns the whole feature off.

## Incident, 2026-09-17: check-ins silently dropped

The waiver deploy went out before `002_waiver.sql` was applied. Every check-in read a column that did not exist, returned 500, and the kiosk queued it and showed the student a checkmark anyway. `/health` stayed green because it never read that column. Found when the kiosk footer showed "2 check-ins waiting to sync" and a reload did not clear it.

Fixed by applying the migration. Hardened so it cannot repeat or hide:
- `src/schema-caps.js` asks the database whether the optional column exists, cached per isolate. Check-in, staff roster, member lookup and roster sync all branch on it, so a pending migration degrades the waiver feature and leaves attendance working.
- `/health` now reports `schemaCurrent` and returns 503 naming the missing migration.
- The kiosk drains its offline queue on `visibilitychange` and `pageshow`, not only the 30 s timer. iOS suspends timers on a sleeping iPad, which is why the retries never fired.

If the footer ever shows a stuck queue again: check `/health` first. `schemaCurrent: false` means a migration is pending.

## Incident, 2026-09-25: waiver reminders never went out

The Worker side of §15.1 has been writing `checkin_last_at` since 2026-09-17. The GHL side was never finished: no such field existed in the sub-account until the btt-ops session created it on 2026-09-25, and there was no workflow. Every nudge failed with "custom field checkin_last_at not found in GHL", the caller only logged it to the console, and nothing on `/health` moved. The on-screen QR worked the whole time; the text reminder never existed.

What changed:
- `src/fields.js` holds the list of every custom field the Worker writes. The roster sync checks that list against GHL every run (one extra read per hour, cached) and goes `degraded` naming any that are missing. `/health` shows `missingFields` and goes `ok: false` while any are missing, with "Writes to them are being lost" in the error. Had this existed on 2026-09-17 it would have gone red within the hour.
- A nudge that fails is written to `sync_log` as `job = 'waiver'`. `/health` shows `waiverFailures24h` and `waiverLastFailure`. These do not flip `ok`, same as a rollup outcome; they are there to be read.
- The GHL workflow "Check-In: Waiver reminder" is being built on the btt-ops side (fires on the field changing, skips `waiver-signed`, at most one reminder every 3 days via a `waiver-reminder-sent` tag).

Known gap: the field is written on the kid's contact, which often has no phone or email. The fix is §15.3 Phase 1b's `payer_contact_id`; until then, kids' reminders reach nobody.

## V2: stripe tracking (§15.2)

Built 2026-09-23. Kids programs, 7 classes per stripe. Needs, in this order:

1. D1 migration, once, **before** the deploy:
```
wrangler d1 execute btt-checkin --remote --file=src/db/migrations/003_promotions.sql
```
2. `wrangler deploy`.

Then a **Stripes** tab appears on `/staff`. It lists members on a kids program who have reached 7 attended classes since their last recorded stripe, most overdue first, with a "3 worth" tag when someone is several intervals past. Two taps record a stripe, which clears them and starts the next interval. Member lookup gains a stripes and belts history with an undo on the most recent, for a mis-tap.

Tune in `wrangler.toml`: `STRIPE_CLASSES` (currently 7) and `STRIPE_PROGRAMS` (currently the three kids programs; add `adult` when you want it, or blank the value to hide the tab).

Wording is deliberate: "eligible for review", never "due". The count is one input; the promotion is your call.

Deploying before the migration is safe now: the tab reports that its migration is pending and the rest of the staff page keeps working.

Not built: a GHL notification on a threshold. That needs a sixth custom field, which is yours to create and name. The tab covers most of the need; ask if you still want the alert.

## V2: drink tab (§15.3)

Built 2026-09-25, all seven steps of the build order in `CLAUDE.md` §15.3. The $0.50 test settled that afternoon (charged about ten hours after the invoice went out), so the close-out is built too.

**What the close-out does.** On the Tab view, **Review and charge** lists every payer with open lines: their total, and either the card that will be charged (brand, last four, where it was saved), "Rolling (under $5)", "No card on file" or "Missing email or phone". The card check runs one payer at a time from the page. One button, "Charge N members, $X", asks for a confirm tap, then works through the payers one per request with live progress. Each payer gets one GHL invoice schedule with saved-card auto-pay; GHL texts and emails them its standard invoice message and charges the card sometime that day. Every step is written to D1 before the next runs, so a crash mid-way resumes without a second invoice. **Check** reads the invoice status; **Charged at POS** closes a payer by hand with no GHL call, for a failed charge or a member with no saved card. A payer with no card is flagged so the drink row hides for them until you clear it on their member screen.

**The first live close-out should be you alone**, with drinks worth $5 on your own tab, watched on the staff page. The response shapes from GHL were observed once, not documented, and the code reads them tolerantly; one real run through the review screen confirms them. If a row lands on "needs a look", read the note on it before pressing anything.

Timing to expect: the invoice email arrives within minutes; the charge lands later that day. The row reads "Charging on <day>" until then, and "Paid" once it is seen. A row still unpaid the day after the charge day reads "Not paid, needs a look".

**It runs itself.** Since 2026-09-26 the cron charges everyone who is due at 8 PM ET (`TAB_AUTO_HOUR` in `wrangler.toml`; blank makes it button-only). The PIN typed at the kiosk is the member's authorization, so nothing waits on a person. The Tab view says when the last run happened and what it did, and the review screen is still there to remove a wrong line before 8 PM, charge early, retry a row, or mark one Charged at POS. `/health` shows `lastTabRun` and `lastTabOutcome`; `degraded` means a row needs a look on the Tab view.

What the member gets, checked on the live account 2026-09-26: **one email** when the invoice generates ("Invoice auto payment information": a payment of $X is due today) and a receipt email after the charge. No text. The only switches for it are account-wide (Payments → Invoices → Settings → Notifications → Customer Notifications → "Auto payment information"), so turning it off would also silence it for every other auto-pay invoice. Your call; it stays on until you say. Receipts are a separate switch and keep going either way.

What a member sees: after an adult checks in, the success screen asks "Thirsty?", shows `Water $1` and `Hydration $3`, and says in small print "Charged to your account." Tapping one asks for their 4-digit purchase PIN on a big keypad. A member with no PIN yet sees "Text me a setup link"; the Worker writes the link to the `purchase_pin_link` field and your GHL workflow texts it. The link opens `/pin`, where they pick the PIN. Kids never see any of this. A purchase is online only: if it does not reach the server, the screen says "That didn't go through. Nothing was added to your tab." and nothing is queued.

What staff see: a **Tab** view on `/staff` with the day's lines, a running total of what is open, remove with a confirm tap, today's wrong-PIN count, and anyone locked (5 wrong PINs in 15 minutes locks that member for 15 minutes) with a clear button. The member screen gains a Tab section: open lines, history, PIN state, **Set up PIN** (opens the same setup screen for the member to type on; staff never type a PIN), clear lockout, and clear the no-card flag (set by the close-out when it finds nothing to charge; hides the drink row until cleared).

Needs, in this order:

1. The secret, once:
```
wrangler secret put PIN_PEPPER
```
Paste a long random string (30 or more characters). It is what protects the PINs; a copy of the database is useless without it. If it is ever changed, every PIN stops working and everyone sets a new one.
2. The migration, once, **before** the deploy:
```
wrangler d1 execute btt-checkin --remote --file=src/db/migrations/004_tab.sql
```
3. `wrangler deploy`.
4. Open `/health`. `tab.enabled` should be `true`, `tab.schema` `true`, `missingFields` `[]`. If `purchase_pin_link` is listed as missing, the workflow field name and the Worker's disagree; the field key must be `purchase_pin_link`.

Deploying before the migration is safe: the drink row and the Tab view stay hidden, `/health` says which migration is pending, and check-in is untouched. Deploying without `PIN_PEPPER` is also safe: `/health` names it, and a PIN request fails with the member-facing failure line rather than a crash.

Tune in `wrangler.toml`: `TAB_ITEMS` (blank turns the whole thing off), `TAB_PROGRAMS` (`adult`; a member buys only if every program they hold is listed, which keeps the 14-year-old in the adult class out until kids are billed to a parent), `TAB_MIN_CENTS` and `TAB_MAX_ROLL_DAYS` (used by the close-out), `PUBLIC_ORIGIN` (the host in the texted link). Prices and the GHL product ids are in `tab-items.json`; edit, `npm test`, commit, deploy.

**Platform limits, recorded as unverified.** The build order asked for Cloudflare's current subrequest and CPU limits to be checked first. This container's network proxy blocks `developers.cloudflare.com`, so they could not be read here. The design assumes, from memory: 50 outbound calls per request on Workers Free, and that D1 queries count toward that. Nothing built so far comes near it (a purchase is a handful of D1 queries and no GHL call; a setup link is one GHL write). The close-out is designed for one payer per request so it stays under it whatever the exact number. Please open that page once and paste the two numbers; they go here. WebCrypto HMAC-SHA256, which the PIN uses, was exercised in Node's implementation of the same API and is the same primitive the opaque ids have used since day one.

Known limit, not part of this work: the nightly rollup pushes every pending contact in one cron invocation, one GHL call each. Fine at today's numbers; it will need batching before the roster is in the dozens of pending contacts a night.

## Still open after go-live

- Rotate `STAFF_PIN`; the first one was pasted into a chat.
- Confirm the four class durations in `schedule.json`.
- iPad: Add to Home Screen, Guided Access, auto-lock off.
- Consider Workers Paid ($5/month) for the request and D1 caps.
- Run the first live close-out on yourself alone and confirm the row goes Charging, then Paid.
- Read the Cloudflare limits page once and paste the subrequest and CPU numbers for this plan into the §15.3 section above.

## Shipping a change from a session branch

The agent pushes to a `claude/...` branch. You merge it into `main` and deploy.
**Fetch first.** `git merge --ff-only origin/<branch>` merges your *local copy*
of that remote branch. If the copy is stale the merge is a silent no-op that
says "Already up to date", and you then deploy the code you already had. That
happened on 2026-09-24: two commits looked merged and deployed, and neither
was.

```
git fetch origin
```
```
git merge --ff-only origin/<branch>
```
```
git push origin main
```
```
wrangler deploy
```

Two lines in the deploy output tell you it really went out:

- the bindings list shows any new `env.*` var the change added
- the asset upload says `+ /staff.html` or `+ /index.html` when a page changed,
  not "No updated asset files to upload"

If a change adds a migration, run it before the deploy that needs it (§15.1),
and check `/health` afterwards for `schemaCurrent`.

## Deploy, first time (PowerShell, inside `C:\Users\Johnm\btt-checkin`)

```
git pull origin main
```
```
npm install
```
```
npm test
```
```
wrangler d1 create btt-checkin
```
Paste the returned `database_id` into `wrangler.toml` replacing `REPLACE_WITH_D1_DATABASE_ID`, then:
```
git commit -am "D1 database id"
```
```
git push origin main
```
```
wrangler d1 execute btt-checkin --remote --file=src/db/schema.sql
```
```
wrangler secret put GHL_TOKEN
```
```
wrangler secret put STAFF_PIN
```
```
wrangler secret put ID_SALT
```
```
wrangler deploy
```

Wrangler prints the `*.workers.dev` URL. Open `/health` there. Expect `ok: true`, `memberCount: 0`, `schedulePresent: true`.

## First run

Trigger the roster sync now instead of waiting 30 minutes. Replace the URL and PIN:
```
Invoke-RestMethod -Method Post -Uri "https://btt-checkin.YOUR-SUBDOMAIN.workers.dev/api/staff/sync" -Headers @{ "x-staff-pin" = "1234" }
```
Expect `outcome: ok` and a member count. If `flagged` lists names, those founding members have no program tag yet.

Then open `/health` again and confirm `memberCount` is above zero.

## Acceptance test (§12)

1. On the iPad open the root URL. Type your name, tap your tile, tap CHECK IN. You should see the success screen with your class count.
2. Open `/staff` on your phone, enter the PIN, and confirm you appear on tonight's roster.
3. Tap Remove twice on your row, then add yourself back with "+ Add student".
4. Trigger the rollup once so the five GHL fields fill in:
```
Invoke-RestMethod -Method Post -Uri "https://btt-checkin.YOUR-SUBDOMAIN.workers.dev/api/staff/rollup" -Headers @{ "x-staff-pin" = "1234" }
```
Expect `outcome: ok` and `pushed: 1`. Open your contact in GHL and check the custom fields. If `missingFields` is non-empty, a field key is misspelled in GHL.

## Operating it

- `/health` shows the last roster sync, the last rollup, their outcomes, how many contacts are waiting for a rollup, `missingFields` (custom fields the Worker writes that GHL does not have; `ok` goes false while any are listed), `waiverFailures24h` with the latest reason, and `tab` (enabled, schema present, any misconfiguration). A pending migration for any feature that is switched on makes `ok` false and names the file.
- Outcomes mean: `ok` the job ran and did its work; `degraded` it ran but something was off (zero members, a missing field, a failed contact) and the detail says what; `failed` it could not do its job and touched nothing.
- To read the log:
```
wrangler d1 execute btt-checkin --remote --command "SELECT ran_at, job, outcome, detail FROM sync_log ORDER BY id DESC LIMIT 10"
```
- The staff page has a Sync roster now button. The rollup runs nightly at 03:00 ET or on demand with the command above.
- To change the schedule, edit `schedule.json`, run `npm test`, commit, push, `wrangler deploy`.
- A failed check-in on the iPad is queued and retried every 30 seconds. A small line at the bottom of the kiosk shows how many are waiting.
- **To fill in a class nobody tapped for:** open `/staff`, walk the date bar back to that day, tap the class, then Add student for each person.
- **To fill in one person:** Members, search them, open them, **Add a class**. Pick the day and tap the class. Only their classes are listed, and one they are already on says so.
- Either way it reaches back thirty days, and the record lands on the class you picked, not on today, so last-attended and the 30-day and week counts all come out right in GHL on the next nightly rollup.

## Local development

```
Copy-Item .dev.vars.example .dev.vars
```
Fill in the three values, then:
```
wrangler d1 execute btt-checkin --local --file=src/db/schema.sql
```
```
wrangler dev --local
```
The GHL calls will fail locally unless `.dev.vars` carries a real token. Everything else works against the local D1.

## Custom hostname

DNS for bttbridgewater.com lives at Spaceship and the site is on Netlify, so
`checkin.bttbridgewater.com` is served by Netlify proxying to the Worker
rather than by a Cloudflare custom domain. Pieces:

1. Spaceship: CNAME `checkin` to the Netlify site.
2. Netlify: add `checkin.bttbridgewater.com` as a domain alias.
3. Site repo `netlify.toml`:
```
[[redirects]]
  from = "https://checkin.bttbridgewater.com/*"
  to = "https://btt-checkin.black-term-300b.workers.dev/:splat"
  status = 200
  force = true
  headers = { X-Proxy-Key = "<same value as the PROXY_KEY secret>" }
```
4. Worker: `wrangler secret put PROXY_KEY` with that value. With it, the
   public routes rate-limit by the real visitor address Netlify forwards
   instead of by Netlify's own address. Without it everything still works,
   but all proxied visitors share one bucket. Staff login never trusts the
   forwarded address, so a leaked key cannot help brute-force the PIN.
   Keeping the key out of the public site repo (a Netlify env var read by
   an edge function) is nicer but not required.

The workers.dev address keeps working alongside. If DNS ever moves to
Cloudflare, replace all of this with a Custom Domain on the Worker.

## Not built (V2, per §10 and §13)

Family view, member portal, QR codes, GHL calendar sync, notes, class billing and dues. (Stripes and belts came in as an approved V2 item, §15.2, and are built. The drink tab, §15.3, is built through the close-out.) `schedule.json` stays the source of truth for classes until V1.1 replaces it with the GHL calendar sync.
