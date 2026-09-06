# btt-checkin STATUS

**Last updated:** 2026-09-06
**Build order (§10):** steps 1 through 7 complete. V1 is code-complete and has never been deployed.

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
| Tests | `test/` | `npm test`: 128 unit tests, no network. `npm run test:browser` needs Playwright |

## Decisions made without you (confirm or say otherwise)

1. **Check-in window.** Implemented as 45 minutes before class start to 15 minutes after. The brief's wording could read the other way round. The two constants are at the top of `src/classes.js`.
2. **Last-name search.** The public roster ships `lastKey`, the first four normalized letters of the last name, so "silva" still finds Jack S. The kiosk never receives a full last name.
3. **Voided rows come back.** If staff remove someone and that person then checks in again for the same class, the row is set back to attended. Staff see the new tap time.
4. **Open mat.** "Check in anyway" records `open mat / unscheduled` at `T00:00` for that date, once per member per day.
5. **Inactive members** appear on the kiosk and can check in. The record carries `status_at_checkin = inactive`. Staff see an inactive tag on the roster row.
6. **Late queued check-ins** are accepted for up to three days back. Anything older is refused.
7. **Rollup week** is Monday to Sunday in ET. At Monday 03:00 the week count resets to zero for everyone.
8. **Cron for 03:00 ET** is registered at both 07:00 and 08:00 UTC. The handler runs it only when the ET hour is 3. This holds across DST without a redeploy.
9. **Compatibility date** is 2026-08-01. Wrangler is pinned to the 4.129 line.

## Things the brief got wrong or left open

- The staff mock shows "Sat Sep 6". 2026-09-06 is a Sunday. The code uses real weekdays.
- Class durations (30 / 45 / 60 / 60) are still the inferred values. They affect nothing today, since the window is computed from the start time alone. Confirm them anyway so `schedule.json` is true.
- Founding members without a `program:*` tag land in Adult and are listed by name in the roster sync log detail. Setup task 4 clears that list.

## Your setup tasks before first deploy (§11)

1. GHL: mint the `BTT Check-In` Private Integration with exactly `contacts.readonly`, `contacts.write`, `locations/customFields.readonly`.
2. GHL: create five contact custom fields with these exact keys: `attendance_last`, `attendance_30d`, `attendance_lifetime`, `attendance_week`, `attendance_class_count_label`. Text type is fine for all five.
3. GHL: tag every `founding-member` contact with one `program:*` tag.
4. Drop the logo at `public/logo.png`. Until then the kiosk hides the image slot.
5. Pick a 4-digit staff PIN and a long random `ID_SALT` (32 or more characters). Changing either later signs all staff out.

## Deploy (PowerShell, inside `C:\Users\Johnm\btt-checkin`)

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

- `/health` shows the last roster sync, the last rollup, their outcomes, and how many contacts are waiting for a rollup.
- Outcomes mean: `ok` the job ran and did its work; `degraded` it ran but something was off (zero members, a missing field, a failed contact) and the detail says what; `failed` it could not do its job and touched nothing.
- To read the log:
```
wrangler d1 execute btt-checkin --remote --command "SELECT ran_at, job, outcome, detail FROM sync_log ORDER BY id DESC LIMIT 10"
```
- The staff page has a Sync roster now button. The rollup runs nightly at 03:00 ET or on demand with the command above.
- To change the schedule, edit `schedule.json`, run `npm test`, commit, push, `wrangler deploy`.
- A failed check-in on the iPad is queued and retried every 30 seconds. A small line at the bottom of the kiosk shows how many are waiting.

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

## Custom hostname (later)

Once stable, add a CNAME for `checkin.bttbridgewater.com` at Spaceship pointing at the Worker and add a custom domain to the Worker in the Cloudflare dashboard. The cookie is marked Secure, so the staff page needs HTTPS, which both hostnames have.

## Not built (V2, per §10 and §13)

Belt tracking, promotions, family view, member portal, QR codes, GHL calendar sync, notes, billing of any kind. `schedule.json` stays the source of truth for classes until V1.1 replaces it with the GHL calendar sync.
