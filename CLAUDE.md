# btt-checkin — Build Brief

**Owner:** Johnny (BTT Bridgewater)
**Written:** 2026-09-06
**What this is:** the member check-in kiosk for Brazilian Top Team Bridgewater. An iPad at the front desk. A student types the first letters of their name, taps their tile, and they are checked in to the class that is about to start. Staff can see tonight's roster and fix a missed check-in in one tap. Attendance is the only thing this system is the source of truth for.

This is a new repo and a new Worker. It shares nothing with `btt-ops` except the Cloudflare account and the GHL sub-account. Do not import from, deploy to, or modify `btt-ops`.

---

## §0 Working agreement

These govern every session on this repo.

0.1 **Inventory before acting.** Read this file, then `git log`, then `STATUS.md` if it exists. If the premise of a task doesn't match the repo, stop and say so before touching anything.

0.2 **Never invent identifiers.** Tag names, custom field IDs, calendar IDs, contact IDs, class names. If it isn't in this file, `schedule.json`, or a tool result, ask.

0.3 **Never quote a SHA, version, or count you haven't read from a tool result.**

0.4 **Johnny deploys.** This container has no wrangler auth and never will. You commit and push to `main`. Johnny runs `wrangler deploy` from PowerShell on his machine (`C:\Users\Johnm\btt-checkin`). End every session with the exact commands he needs, one per code block.

0.5 **Reads before writes to GHL.** Every GHL call is a GET unless it is one of the two allowed writes in §6. Anything else is a bug.

0.6 **`ok` means "I checked," never "nothing came back."** Any sync that returns zero members, zero classes, or zero attendance for a day when classes ran must be flagged, not logged as success.

0.7 **Windows user.** Commands go in PowerShell. One command per code block. Assume CRLF and UTF-8 BOM are possible in any file Johnny edits; parsers must tolerate both.

0.8 **When a session compacts, the report must say what you changed, not what you confirmed.** A report that only verifies is a sign the task was lost.

0.9 **Copy rules for anything a member sees:** no exclamation points, no em dashes, no emoji except the single checkmark on the success screen. Short. Warm. BTT voice.

---

## §1 Architecture

```
iPad (Safari, Guided Access)
   │  HTTPS
   ▼
Cloudflare Worker  btt-checkin
   ├── serves the kiosk page (static HTML/JS, no framework, no build step)
   ├── serves the staff page (same origin, PIN-gated)
   ├── /api/*  JSON routes
   ├── cron: roster sync from GHL      every 30 min
   ├── cron: rollup push to GHL        nightly 03:00 ET
   └── D1  btt-checkin
          members · attendance · sync_log · pending_rollups
                          │
                          ▼
                    GHL REST API (contacts read, custom fields write)
```

**Stack:** Cloudflare Workers, D1, plain HTML/JS/CSS served from the Worker. No Next.js, no React, no bundler, no npm runtime dependencies beyond `wrangler` and a test runner. The kiosk page is one file. The staff page is one file.

**Why plain:** one deploy artifact, nothing to build, nothing to break at 4 PM on a Tuesday.

**Hostname:** `checkin.bttbridgewater.com` (Johnny adds a CNAME at Spaceship to the Worker once it's stable; `*.workers.dev` URL until then).

---

## §2 The kiosk experience

Home screen, portrait iPad, big type, dark background (`#09090a`), bone text (`#f4f1e9`), gold accent (`#e7c24c`), Oswald for display, Inter for body. Logo top center (Johnny supplies the PNG).

```
BRAZILIAN TOP TEAM BRIDGEWATER

Check in

[ Type your name ]
```

Rules:

- Search matches on first name prefix, last name prefix, or "first last" prefix. Case-insensitive. Diacritics stripped.
- Results appear after 2 characters. Max 6 tiles. Tile shows **first name + last name** and program label (Kids 3-5 / Kids 6-9 / Kids 10-14 / Adult). Nothing else. (Changed from last initial to full last name by Johnny, 2026-09-06.)
- Tapping a tile shows the confirm screen:

```
Jack S.
Kids 6-9

Kids 6-9  4:30 PM

[ CHECK IN ]
```

- The class is **pre-selected** from `schedule.json`: the class for this member's program whose start time is within the window: from **3 hours before** start to **3 hours after** start, ET. (45 / 15 at first; 120 / 20 by Johnny on 2026-09-06; 180 / 180 by Johnny on 2026-09-16, "wide and easy".) Both numbers are `CHECKIN_EARLY_MIN` and `CHECKIN_LATE_MIN` in `wrangler.toml`, so changing them is a config edit and a deploy, not a code change. At this width most of a day's classes are in the window at once; the program tag is what picks one, and no program has two classes on the same day, so a single-program member is never offered a choice within their own program. If exactly one matches, show it. Kids classes stack back to back on weekdays, so the program tag is what disambiguates; the window alone never decides. If two match (a member with two program tags, e.g. a 14-year-old approved for adult), show both as large buttons. If none match, show "No class right now" and a single button "Check in anyway" that records attendance with `class_name = "open mat / unscheduled"`.
- Tap CHECK IN. Success screen for 3 seconds, then back to home:

```
✓ You're checked in
Kids 6-9, 4:30 PM
Class #37
```

- Duplicate guard: same member, same class, same day = no second record, but still show the success screen. Never show an error to a student. (§15.3: this and the offline queue cover check-in only. A purchase is online-only and says so when it fails.)
- Billing, membership status, balances, holds: **never shown on the kiosk.** If a member is flagged inactive in GHL, the kiosk still checks them in and writes `status_at_checkin = "inactive"` on the record. Staff see it. The student doesn't. (§15.3 adds one exception: the drink row and its prices. Never a balance or a tab total.)
- 60 seconds idle on any screen returns to home.
- The page caches the roster in memory after load and re-fetches every 10 minutes. If a POST fails, the check-in is queued in `localStorage` and retried every 30 seconds. The success screen shows regardless. Queued records carry their original timestamp.

---

## §3 Staff mode

Same Worker, route `/staff`. A 4-digit PIN (Worker secret `STAFF_PIN`) sets a cookie for 12 hours.

Screens:

**Tonight**
```
Sat Sep 6
10:30 AM Kids 3-5      6 checked in
11:00 AM Kids 6-9     14 checked in
11:45 AM Kids 10-14    9 checked in
1:00 PM  Adult BJJ    11 checked in
```

**Class roster** (tap a class)
```
Kids 6-9  11:00 AM
✓ Jack S.     10:52
✓ Emma J.     10:55
...
[ + Add student ]
[ Remove ] on each row (soft delete: sets status = "voided", never hard deletes)
```

**Add student** opens the same search as the kiosk and records attendance with `method = "staff"`. Tonight's date bar goes back, so a class nobody tapped for can be filled in later: a staff add reaches back `STAFF_BACKDATE_DAYS` (30) where the kiosk reaches back `KIOSK_BACKDATE_DAYS` (3). (Split by Johnny, 2026-09-24; both were 3.) The row lands on the class it names, so `attendance_last`, `attendance_30d` and `attendance_week` all come out on the right date. `checked_in_at` stays the staff tap, which is the truth.

**Member lookup** (search any member): last 30 days of attendance, lifetime count, sync status, and promotion history (§15.2). It was read-only in V1; two things write from it now, recording a stripe and Add a class.

**Add a class** (on the member screen, added 2026-09-24) is the way in when one person was missed rather than a whole class: three taps instead of walking the date bar back and opening the class. Pick the day (the picker is bounded by `STAFF_BACKDATE_DAYS`, so it never offers a day the server would refuse), see only that member's classes for it, tap one. A class they are already on is marked, and tapping it anyway is a harmless duplicate. Open mat is always offered. If nothing in their program runs that day, that day's other classes are listed rather than none, because staff know better than the program tag does.

No belt tracking, no notes, no billing in V1. Promotions since arrived as an approved V2 item (§15.2).

---

## §4 Schedule

`schedule.json` at repo root. Committed. Deploy to change. **This is the real schedule as published on bttbridgewater.com/schedule on 2026-09-06.** Sunday, Monday and Friday have no classes.

```json
{
  "timezone": "America/New_York",
  "programs": {
    "kids-3-5":   { "label": "Kids 3-5",   "tag": "program:kids-3-5" },
    "kids-6-9":   { "label": "Kids 6-9",   "tag": "program:kids-6-9" },
    "kids-10-14": { "label": "Kids 10-14", "tag": "program:kids-10-14" },
    "adult":      { "label": "Adult",      "tag": "program:adult" }
  },
  "classes": [
    { "name": "Kids 3-5",     "program": "kids-3-5",   "days": ["Tue","Thu"], "start": "16:00", "minutes": 30 },
    { "name": "Kids 6-9",     "program": "kids-6-9",   "days": ["Tue","Wed","Thu"], "start": "16:30", "minutes": 45 },
    { "name": "Kids 10-14",   "program": "kids-10-14", "days": ["Tue","Wed","Thu"], "start": "17:15", "minutes": 60 },
    { "name": "Adult BJJ",    "program": "adult",      "days": ["Tue","Thu"], "start": "18:15", "minutes": 60 },
    { "name": "Adult No-Gi",  "program": "adult",      "days": ["Wed"],       "start": "18:15", "minutes": 60 },
    { "name": "Kids 3-5",     "program": "kids-3-5",   "days": ["Sat"], "start": "10:30", "minutes": 30 },
    { "name": "Kids 6-9",     "program": "kids-6-9",   "days": ["Sat"], "start": "11:00", "minutes": 45 },
    { "name": "Kids 10-14",   "program": "kids-10-14", "days": ["Sat"], "start": "11:45", "minutes": 60 },
    { "name": "Adult BJJ",    "program": "adult",      "days": ["Sat"], "start": "13:00", "minutes": 60 }
  ]
}
```

**Durations are inferred from the gaps between start times and are unconfirmed.** They only affect the check-in window, so a wrong guess is cosmetic, but Johnny should confirm them. Wednesday is No-Gi across the board; the kids classes keep their names, the adult class is named "Adult No-Gi" so rosters read correctly.

Teens 15+ train in adult classes and carry `program:adult`. A 14-year-old approved for adult carries both `program:kids-10-14` and `program:adult`. Foundations cohort members train in the Adult BJJ slots in V1.

Validate on startup: no overlapping same-program classes, valid days, valid times. Fail loudly on bad JSON.

**V1.1 (not now):** replace `schedule.json` with a 30-minute sync from the GHL Classes calendar group. Keep the JSON shape as the internal contract so nothing downstream changes.

---

## §5 Data model (D1)

```sql
CREATE TABLE IF NOT EXISTS members (
  ghl_contact_id TEXT PRIMARY KEY,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  programs       TEXT NOT NULL,   -- JSON array of program keys, e.g. ["kids-6-9"]
  active         INTEGER NOT NULL DEFAULT 1,
  synced_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ghl_contact_id     TEXT NOT NULL,
  class_name         TEXT NOT NULL,
  class_start_local  TEXT NOT NULL,   -- "2026-09-06T17:00" ET, the scheduled start
  checked_in_at      TEXT NOT NULL,   -- ISO UTC, actual tap time
  method             TEXT NOT NULL CHECK (method IN ('kiosk','staff')),
  status             TEXT NOT NULL DEFAULT 'attended' CHECK (status IN ('attended','voided')),
  status_at_checkin  TEXT NOT NULL DEFAULT 'active',
  UNIQUE (ghl_contact_id, class_start_local)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job       TEXT NOT NULL,             -- 'roster' | 'rollup'
  ran_at    TEXT NOT NULL,
  outcome   TEXT NOT NULL,             -- 'ok' | 'degraded' | 'failed'
  detail    TEXT
);

CREATE TABLE IF NOT EXISTS pending_rollups (
  ghl_contact_id TEXT PRIMARY KEY,
  queued_at      TEXT NOT NULL
);
```

Every check-in inserts into `pending_rollups` so the nightly job only touches contacts that changed.

---

## §6 GHL integration

**Token:** `GHL_TOKEN`, a **new** Private Integration named `BTT Check-In`, minted by Johnny with exactly these scopes: `contacts.readonly`, `contacts.write`, `locations/customFields.readonly`. Nothing else. Never reuse the btt-ops token.

**Location:** `ARCSFhJ0JlkcuzfZtyEJ`.

**Roster sync (every 30 min):**
- `GET /contacts/` and paginate fully. A contact is a member if it carries **any** of: a `program:*` tag from `schedule.json`, the tag `founding-member`, or any tag starting with `foundations-` (currently `foundations-sept` and `foundations-oct`; future cohorts follow the same prefix and need no code change). (Program tag alone added by Johnny, 2026-09-07: not everyone enrolls through Foundations.) A tag that starts with `program:` but matches nothing in the schedule is flagged by name as a likely typo.
- `programs` from tags: each `program:*` tag that matches a key in `schedule.json` is added. Rules for contacts with no `program:*` tag:
  - has a `foundations-*` tag → `["adult"]`, no flag needed (Foundations is the adult program)
  - has only `founding-member` → `["adult"]` **and flagged** in `sync_log` detail by name, because founding members include kids and the kiosk cannot match them to a kids class until Johnny tags them.
  - has `program:none` → **not a student**: a paying parent who keeps `founding-member` for billing. Never a kiosk tile, never flagged, and any existing `members` row is removed (attendance stays). (Added by Johnny, 2026-09-07.)
- Contacts that lose all member tags are set `active = 0`, not deleted. Their attendance stays.
- **Emptiness guard:** if the sync returns zero members, log `degraded` and keep the previous roster. Do not wipe the table.

**Rollup push (nightly 03:00 ET):** for each contact in `pending_rollups`, `PUT /contacts/{id}` with custom fields:

| Custom field key | Value |
|---|---|
| `attendance_last` | date of most recent attended, ET, `YYYY-MM-DD` |
| `attendance_30d` | count, last 30 days |
| `attendance_lifetime` | count, all time |
| `attendance_week` | count, current Mon-Sun week |
| `attendance_class_count_label` | e.g. `Class #37`, for merge fields in messages |

Johnny creates these five custom fields in GHL (Settings, Custom Fields, contact type). On first run, the Worker resolves field keys to IDs via `GET /locations/{id}/customFields` and caches them. If any of the five is missing, log `degraded` with the missing key and skip that field; never fail the whole push.

**Allowed writes, exhaustively:** `PUT /contacts/{id}` with custom field values. That was the only write until §15.3 (2026-09-25), which adds the invoice-schedule calls listed there. The write scanner test is an explicit allowlist of method + path pairs; anything else fails the suite.

---

## §7 Routes

```
GET  /                    kiosk page
GET  /staff               staff page (PIN gate)
POST /api/staff/login     { pin } → cookie
GET  /api/roster          [{ id, first, last, program, programs }]   (public, minimal)
GET  /api/current-class   { now, matches: [...] }  computed server-side from schedule.json
POST /api/checkin         { contactId, classStartLocal, className, clientTs }  (public)
GET  /api/staff/today     classes + counts        (PIN)
GET  /api/staff/class     ?start=… roster          (PIN)
POST /api/staff/add       manual check-in          (PIN)
POST /api/staff/void      { attendanceId }         (PIN)
GET  /api/staff/member    ?id=… history            (PIN)
GET  /health              { ok, lastRosterSync, memberCount, schedulePresent }
```

Public routes rate-limited to 60 requests / minute / IP. Public roster response never includes contact IDs beyond an opaque `id` that maps server-side; use the GHL contact ID hashed with a Worker secret `ID_SALT`, and resolve on POST.

---

## §8 Secrets and config

Secrets (Johnny sets with `wrangler secret put`):
- `GHL_TOKEN`
- `STAFF_PIN`
- `ID_SALT`
- `PIN_PEPPER` (§15.3)

Vars in `wrangler.toml`:
- `GHL_LOCATION_ID = "ARCSFhJ0JlkcuzfZtyEJ"`
- `TZ = "America/New_York"`
- `MEMBER_TAGS = "founding-member"`
- `MEMBER_TAG_PREFIXES = "foundations-"`
- `CHECKIN_EARLY_MIN = "180"` and `CHECKIN_LATE_MIN = "180"` (§2 window, minutes)
- `KIOSK_BACKDATE_DAYS = "3"` and `STAFF_BACKDATE_DAYS = "30"` (§3 backdating, whole days)
- `TAB_ITEMS`, `TAB_PROGRAMS`, `TAB_MIN_CENTS`, `TAB_MAX_ROLL_DAYS`, `TAB_AUTO_HOUR` (§15.3 drink tab; empty `TAB_ITEMS` turns it off, empty `TAB_AUTO_HOUR` makes charging button-only)

`.dev.vars.example` committed; `.dev.vars` gitignored. Parser must handle CRLF and BOM.

---

## §9 Tests

Vitest or node test runner, fixtures only, no network. Minimum:

1. Search: prefix on first, last, and full name; diacritics; 2-char threshold; 6-result cap.
2. Class matching: window edges, back-to-back kids classes resolved by program tag, member with two program tags, none, Wednesday No-Gi naming, DST transition days.
3. Duplicate guard: same member + same class start = one row.
4. Voiding: sets status, never deletes.
5. Roster sync: `founding-member` and `foundations-*` prefix matching, program tag parsing, foundations-without-program → adult silently, founding-without-program → adult + flag, zero-result → degraded + table untouched.
6. Rollup math: 30d, week (Mon-Sun ET), lifetime, label.
7. Write scanner: no GHL write other than `PUT /contacts/{id}`.
8. Schedule validation: rejects overlap, bad day, bad time.
9. Kiosk page: never contains an email, phone, or the string "billing" in rendered HTML. (§15.3: item names and prices are allowed. A balance or tab total is not.)
10. Backdating: the kiosk and staff limits and their exact edges, a stale `clientTs` on a staff backfill, config override and fallback.
11. Drink tab (§15.3): PIN hashing and constant-time compare, setup-token expiry and single use, the 10-minute link limit, lockout edges, kids exclusion, the no-card flag, online-only failure copy, feature off when `TAB_ITEMS` is empty, pending migration hides everything and never touches check-in. Close-out fixtures: a crash after `schedule_created` creates no second schedule, a stuck schedule is adopted by exact name only, an already-active schedule is not re-activated, a test-mode transaction is skipped, a POS-only card is skipped, no card, missing email or phone, a tab under `TAB_MIN_CENTS` rolls, a `TAB_MAX_ROLL_DAYS`-old tab under the minimum is charged, and Charged at POS makes no GHL call.

---

## §10 Build order

Ship in this order. Each step ends with tests green and a push to `main`.

1. Repo scaffold, `wrangler.toml`, D1 schema, `schedule.json` from §4, `/health`.
2. Roster sync + emptiness guard, against fixtures.
3. `/api/roster`, `/api/current-class`, `/api/checkin` with duplicate guard.
4. Kiosk page. Test on a phone-sized viewport and an iPad-sized one.
5. Staff page: login, today, class roster, add, void.
6. Rollup push against fixtures.
7. `STATUS.md` with deploy steps for Johnny.

**Do not start V2 items** (belt tracking, promotions, family view, member portal, QR, GHL calendar sync) in any session unless this file is updated to say so.

---

## §11 Johnny's setup tasks (before first deploy)

1. Create the GitHub repo `johnnyloreti/btt-checkin` (private) and clone to `C:\Users\Johnm\btt-checkin`.
2. GHL: mint the `BTT Check-In` Private Integration with the three scopes in §6. Copy the token once.
3. GHL: create the five custom fields in §6.
4. GHL: apply one `program:*` tag to every `founding-member` contact (`program:kids-3-5`, `program:kids-6-9`, `program:kids-10-14`, or `program:adult`). Foundations contacts need nothing. A smart list on the `founding-member` tag plus bulk tag actions does this in minutes.
5. Confirm the four class durations in `schedule.json` (30 / 45 / 60 / 60 are inferred).
6. Supply the logo PNG (the circular 798×798 transparent one) as `public/logo.png`.
7. Hardware: an iPad, a counter stand, Guided Access enabled, Safari pinned to the kiosk URL. Wifi at Bridgewater Fitness confirmed reachable from the front desk.

---

## §12 Deploy handoff (Johnny, PowerShell, inside `btt-checkin`)

```
git pull origin main
```
```
wrangler d1 create btt-checkin
```
(paste the returned `database_id` into `wrangler.toml`, commit)
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

Then open `/health` in a browser and confirm `memberCount` is above zero after the first roster sync (trigger it manually via the route the agent provides, or wait 30 minutes).

First real use: check yourself in from the iPad, then open `/staff` and confirm you appear on tonight's roster. That's the acceptance test.

---

## §13 Non-goals for V1

Payment and billing state (lifted for the drink tab only, §15.3, 2026-09-25; class billing, dues and refunds stay out), waivers (the waiver prompt in §15 is the one exception, approved for V2 on 2026-09-07), class booking, reservations, QR codes, key tags, wallet passes, belt tracking, promotions, family accounts, member portal, push notifications, native apps, GHL Custom Objects, reading GHL calendars, any write to GHL other than the five rollup fields, anything that touches `btt-ops`.

---

## §14 Identifiers

- GHL location: `ARCSFhJ0JlkcuzfZtyEJ`
- Cloudflare account: `f02440d24727ce8e65f63b596c336c5e`
- Brand: near-black `#09090a`, bone `#f4f1e9`, gold `#e7c24c`, Oswald display, Inter body
- Timezone: `America/New_York`

---

## §15 V2 items approved

Each item here has been approved by Johnny for a session. Nothing else from the V2 list is.

### 15.1 Waiver prompt (approved 2026-09-07)

A member checks in whether or not they have a waiver on file. Never block, never show an error. But when the waiver is missing:

- **Kiosk:** the success screen adds one line, "One thing before class: sign the waiver", and the waiver QR code (`public/waiver-qr.png`, Johnny supplies). The screen holds longer so the QR can be scanned.
- **Staff:** the roster row shows a "no waiver" tag; member lookup shows waiver status.
- **Text or email:** the Worker never sends messages. Instead, on a check-in without a waiver it writes the custom field `WAIVER_FIELD` (default `checkin_last_at`, ISO timestamp) to that contact right away, using the one allowed write. A GHL workflow triggers on that field changing, checks the waiver tag is absent, and sends the message. Johnny owns the workflow and the message.

Source of truth for "waiver on file" is the tag `WAIVER_TAG` (default `waiver-signed`) on the **student's** contact, read by the roster sync. If `WAIVER_TAG` is empty the feature is off and everyone counts as signed. Kids' waivers are signed by a parent; the GHL side must put the tag on the child's contact, not the parent's.

Schema: `members.waiver INTEGER NOT NULL DEFAULT 1`. Migration in `src/db/migrations/002_waiver.sql`.

**Migration rule, learned the hard way on 2026-09-17.** The waiver code was deployed before that migration ran. Every check-in read `members.waiver`, threw "no such column", and returned 500. Because the kiosk never shows a student an error (§2), it queued each one and showed the checkmark anyway: attendance stopped recording and nothing said so. `/health` did not touch the column, so it stayed green.

So, for any migration from here on:
- **No optional column may be named unconditionally in a query on the check-in path.** Ask `hasWaiverColumn` in `src/schema-caps.js` first and build the SQL accordingly. A pending migration must degrade the feature, never break attendance.
- **`/health` reports `schemaCurrent`** and goes `ok: false` with the migration filename when a column is missing. A half-applied deploy is visible.
- Apply the migration before the deploy that needs it, but the deploy must survive the other order.

**Field rule, learned 2026-09-25.** The GHL side of this feature was never finished: the sub-account had no `checkin_last_at` field until 2026-09-25, so for weeks every nudge wrote to a field that did not exist. `notifyWaiverCheckin` reported it and the caller only `console.warn`ed, so nothing surfaced. Fixed the same day:
- `src/fields.js` lists every custom field the Worker writes (`requiredFieldKeys`). **Any new field the Worker writes is added there.** The roster sync checks the list every run and goes `degraded` naming what is missing; `/health` shows `missingFields` and goes `ok: false` while any are missing.
- A nudge that does not land is written to `sync_log` (`job = 'waiver'`), and `/health` reports `waiverFailures24h` and `waiverLastFailure`.
- Kids: the field is written on the kid's contact, which often has no phone or email for the reminder to reach. §15.3 Phase 1b's `payer_contact_id` is the fix (send to the payer instead). Not built yet.

### 15.2 Stripe tracking (approved 2026-09-23)

Staff need to know who is due to be looked at for a stripe. Johnny: "start with kids, 7 classes per stripe."

**Framing.** The tab surfaces who has crossed a threshold. It never says a promotion is owed. Class count is one input; the instructor decides. Headings read "eligible for review", rows read "N classes since last stripe".

**Eligibility.** For a member whose programs include one of `STRIPE_PROGRAMS`, count attended classes since their last recorded promotion (all attended classes if none). Eligible when that reaches `STRIPE_CLASSES`. A member 22 classes past their last stripe is worth three, so the row shows the count, not a yes/no.

**Recording.** A button on the row writes a `promotions` row holding who, kind, the ET date, and their lifetime count at that moment. That clears them from the list and starts the next interval. The member screen shows promotion history, with an undo on the most recent for a mis-tap.

**Config in `wrangler.toml`:**
- `STRIPE_CLASSES = "7"`
- `STRIPE_PROGRAMS = "kids-3-5,kids-6-9,kids-10-14"` — empty turns the feature off, adults added when Johnny says so.

**Schema:** a `promotions` table. Migration `src/db/migrations/003_promotions.sql`. Per the §15.1 rule, every query must tolerate the table not existing yet: `hasPromotionsTable` in `src/schema-caps.js`, and a pending migration hides the tab rather than breaking the staff page.

**Not built, deliberately.** No GHL notification. That would need a sixth custom field key, which is Johnny's to create and name (§0.2), and the tab removes most of the need. Offer it once the tab has been used.

### 15.3 Drink tab (approved 2026-09-25, revision 3)

A member who checks in can put a drink on their tab. The tab is charged to the card they already have on file, after staff review, through GHL invoices with saved-card auto-pay. Nobody handles money at the desk. Phase 1 is **adults only**. Kids billed to a parent, and merchandise, are later phases, described at the end so Phase 1 is built to take them without rework.

Written from the btt-ops brief (revisions 1 and 2), this session's two reviews, and the GHL facts below, which were verified against the live sub-account from the btt-ops side on 2026-09-25. Nothing here was invented in this repo: every endpoint, field, id and behaviour is either from that verification or from this repo's own code.

**The payment step is proven.** A $0.50 live test invoice was scheduled on 2026-09-25 with `executeAt` 09:01Z against a card saved from a one-time Apple Pay payment through a payment link (`setup_future_usage = off_session`, the same way every funnel and payment-link card is saved). The invoice generated and sent at 09:01Z as `sent`. The saved-card auto-pay charged at 19:02:01Z the same day, about ten hours later and before the due date; the invoice went to `paid`, the transaction was `entitySourceType: invoice`, live, on the same `pm_` and `cus_` ids passed in `autoPayment`. Johnny confirmed on 2026-09-25 and step 6 was built the same day.

#### Amendments to earlier sections (also noted in place)

- **§2 kiosk:** "never shown on the kiosk" still holds for balances, status and holds. The one exception is the drink row and its prices. The kiosk never shows a running tab total. "Never show an error to a student" and the offline queue cover **check-in only**. A purchase is online-only, is never queued on the iPad (that would mean storing a PIN there), and a failed one says so. Check-in behaviour is unchanged.
- **§6 allowed calls:** the list grows to the table under "Allowed GHL calls" below. `test/write-scanner.test.js` becomes an explicit allowlist of exactly those method + path pairs.
- **§8 secrets:** adds `PIN_PEPPER`. `GHL_TOKEN` keeps its name; Johnny widened its scopes on 2026-09-25.
- **§9 test 9:** the kiosk page may contain item names and prices. Never an email, phone, balance, or the word "billing".
- **§13 non-goals:** "Payment, billing state" is lifted for the drink tab only.

#### Who can buy (Phase 1)

A member sees the drink row only if their programs include one of `TAB_PROGRAMS` (`adult`) **and none of the kids programs**. The 14-year-old approved for the adult class (§4) carries both, so they are excluded until Phase 1b bills them to a parent. A member whose last close-out found no usable card (`skipped_no_card`, below) does not see the row either, until staff clear that on the member screen; otherwise a tab grows with nothing behind it.

#### Kiosk flow

1. Check-in is unchanged. Confirm screen, success screen, duplicate guard and offline queue all work exactly as today.
2. For an eligible member, the success screen gains one optional block under the checkmark: "Thirsty?", then `Water $1` and `Hydration $3`, then in small print "Charged to your account." (Johnny, 2026-09-25.) Ignoring it changes nothing and the screen returns home on the normal timer. Tapping an item extends the timer.
3. Tapping an item asks for the member's **purchase PIN** (4 digits, large keypad).
   - Right PIN: the purchase is recorded and the screen says "Added to your tab. Water, $1."
   - Wrong PIN: "That PIN didn't match."
   - Locked: "Purchases are paused for this account. Ask at the desk."
   - Network or server failure: "That didn't go through. Nothing was added to your tab."
4. **Lockouts.** Per member: 5 wrong PINs in 15 minutes locks that member's purchases for 15 minutes. Kiosk-wide: every failed PIN is recorded, and the staff page shows today's count plus any member currently locked. Spraying one common PIN across many members will not trip a per-member lock, but it shows on the staff page, and the review screen shows each line's time so an odd pattern is visible. The real safeguard is the staff review before any charge.
5. A member with no PIN yet sees "Set up your purchase PIN" and one button: "Text me a setup link". The kiosk never lets someone create a PIN on the spot. **At most one setup link per member per 10 minutes**; a second tap inside that window says "We just sent one. Check your texts."

Copy follows §0.9: no exclamation points, no em dashes, no emoji beyond the existing checkmark.

#### Purchase PIN

- **Belongs to the payer**, not the person drinking. In Phase 1 they are the same adult. In Phase 1b a kid's purchase asks for the parent's PIN.
- **Stored** in D1 as `HMAC-SHA256(key = PIN_PEPPER, message = salt || payer_contact_id || pin)` with a random per-member salt, hex. Not PBKDF2: Workers WebCrypto rejects more than 100,000 PBKDF2 iterations, and even that likely exceeds the Free plan's CPU budget per request. Slow hashing does not protect a 4-digit PIN anyway, because anyone holding the table can try all 10,000. The protection is `PIN_PEPPER`, which never touches D1. Compare in constant time. PINs are never stored in GHL or logged.
- **Setup by text, following the §15.1 pattern.** The Worker never sends messages. "Text me a setup link" creates a one-time token (random, 30-minute expiry, single use, stored hashed) and writes the link into the contact custom field `purchase_pin_link` with the allowed contact write. Johnny's workflow "Check-In: Purchase PIN setup link" fires on that field changing and texts the link. The Worker **never clears** that field; it only overwrites it with a new link. The link opens a small page on the Worker (`/pin`) where the member enters the PIN twice. The page talks about purchases generally, not drinks: the same PIN covers merchandise in Phase 2 (Johnny, 2026-09-25).
- **Staff help:** the staff page can open the same setup screen for a member standing at the desk, and the member types the PIN themselves. Staff never type a member's PIN. Staff can also clear a lockout.
- **Forgot PIN** on the kiosk is the same text-a-link flow, under the same 10-minute limit.
- `purchase_pin_link` is added to `requiredFieldKeys` in `src/fields.js` when the tab is on, so a missing field shows on `/health` before the first member taps the button.

#### Recording (D1)

New migration `src/db/migrations/004_tab.sql`. Per the §15.1 rule, every query tolerates these tables not existing yet (`hasTabTables` in `src/schema-caps.js`). A pending migration hides the drink row and the staff tab screens, and never touches check-in.

```sql
CREATE TABLE IF NOT EXISTS purchase_pins (
  payer_contact_id TEXT PRIMARY KEY,
  pin_hash         TEXT NOT NULL,
  salt             TEXT NOT NULL,
  set_at           TEXT NOT NULL,
  set_by           TEXT NOT NULL CHECK (set_by IN ('link','staff')),
  failed_count     INTEGER NOT NULL DEFAULT 0,
  first_failed_at  TEXT,
  locked_until     TEXT
);

CREATE TABLE IF NOT EXISTS pin_setup_tokens (
  token_hash       TEXT PRIMARY KEY,
  payer_contact_id TEXT NOT NULL,
  created_at       TEXT NOT NULL,          -- also enforces one link per member per 10 minutes
  expires_at       TEXT NOT NULL,
  used_at          TEXT
);

CREATE TABLE IF NOT EXISTS pin_failures (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  payer_contact_id TEXT NOT NULL,
  failed_at        TEXT NOT NULL           -- kiosk-wide counter for the staff page
);

CREATE TABLE IF NOT EXISTS purchases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_contact_id  TEXT NOT NULL,         -- who took the item
  payer_contact_id  TEXT NOT NULL,         -- whose card pays (same as buyer in Phase 1)
  item_key          TEXT NOT NULL,
  product_id        TEXT NOT NULL,
  price_id          TEXT NOT NULL,
  unit_amount_cents INTEGER NOT NULL,      -- price at the moment of purchase
  qty               INTEGER NOT NULL DEFAULT 1,
  purchased_at      TEXT NOT NULL,         -- ISO UTC
  method            TEXT NOT NULL CHECK (method IN ('kiosk','staff')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','voided','invoiced')),
  closeout_payer_id INTEGER
);

CREATE TABLE IF NOT EXISTS closeouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  approved_by  TEXT NOT NULL DEFAULT 'staff'
);

CREATE TABLE IF NOT EXISTS closeout_payers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  closeout_id         INTEGER NOT NULL,
  payer_contact_id    TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL,
  invoice_name        TEXT NOT NULL,       -- "BTT tab #<closeout_id>-<8 hex of sha256(payer id)>", unique
  state               TEXT NOT NULL CHECK (state IN
                        ('pending','schedule_created','autopay_on','paid','failed',
                         'paid_at_pos','skipped_no_card','skipped_missing_contact')),
  invoice_schedule_id TEXT,
  invoice_id          TEXT,
  card_brand          TEXT,
  card_last4          TEXT,
  card_source         TEXT,                -- invoice | funnel | payment_link
  detail              TEXT,
  updated_at          TEXT NOT NULL,
  UNIQUE (closeout_id, payer_contact_id)
);

CREATE TABLE IF NOT EXISTS tab_flags (
  payer_contact_id TEXT PRIMARY KEY,
  no_card_since    TEXT NOT NULL           -- set by skipped_no_card; cleared by staff
);
```

Amounts are in cents, copied at purchase time, so a price change never rewrites history. `invoiced` on a purchase means an invoice was created, not that the card was charged; `closeout_payers.state` tracks the charge. `invoice_name` is derived from the close-out id and a short hash of the payer id, so it exists before the row does, is unique without a second write, reads fine on the member's invoice, and carries no GHL id.

#### Items

Phase 1 items live in config so a price change is an edit, not code. `wrangler.toml`:

```toml
# Drink tab (§15.3). Empty TAB_ITEMS turns the feature off.
TAB_ITEMS = "water,hydration"
TAB_PROGRAMS = "adult"
TAB_MIN_CENTS = "500"
TAB_MAX_ROLL_DAYS = "28"
```

`tab-items.json` at repo root, committed, validated on startup like `schedule.json`:

```json
{
  "water":     { "label": "Water",     "product_id": "6ab637c780e11d5e52e6e16a", "price_id": "6ab637c8a45571af67f0ed40", "amount_cents": 100 },
  "hydration": { "label": "Hydration", "product_id": "6ab637c875098f3f8f8ea591", "price_id": "6ab637c880e11d5e52e6e1a3", "amount_cents": 300 }
}
```

These ids are real: the btt-ops session created both products through the GHL API on 2026-09-25 and read the ids from the responses ("Water" $1 and "Hydration Drink" $3, both PHYSICAL, available in store). The kiosk label is "Hydration".

#### Minimum charge (Johnny, 2026-09-25)

A payer is charged when their open tab reaches **$5 (`TAB_MIN_CENTS`) or their oldest open purchase is 28 days old (`TAB_MAX_ROLL_DAYS`), whichever comes first.** Anyone below both rolls to the next close-out. That keeps card fees (about 2.9% plus 30¢ per charge) from eating a third of a $1 water, without letting a light buyer's tab roll forever.

#### Staff page

- **Tonight's tab:** every purchase today, with void (sets `voided`, never deletes).
- **PIN activity:** today's failed-PIN count, and any member currently locked, with a clear-lockout button.
- **Member screen:** that member's open tab and history; open the PIN setup screen for them; clear a lockout; clear a no-card flag.
- **Close out ("Review and charge"):**
  1. Lists every payer with open purchases: their lines with times, their total, and one of: the card that will be charged (brand, last 4 and source), "Rolling to next week ($X, under $5)", "No card on file", or "Missing email or phone". Card status is fetched **one payer per request from the browser** and fills in as it goes, so the screen never needs more than a handful of GHL calls in one Worker request. Staff can void lines.
  2. One button, "Charge N members, $X", creates the `closeouts` row and one `closeout_payers` row per payer to be charged, state `pending`, **before any GHL call**.
  3. The page then works through the payers **one request per payer**, looping from the browser, showing live progress (pending, invoiced, paid, failed, skipped). Each payer takes about five GHL calls, well under the Workers Free limit of 50 outbound calls per request.
  4. Leaving the page and coming back resumes where it stopped.
  5. **Charged at POS:** an action on any payer row that sets `paid_at_pos` with a note and marks their purchases `invoiced`, making no GHL call. Staff already charge saved cards at the GHL POS, so a failed payer, or one the invoice route cannot charge, is closed out by hand. The tab never depends on auto-pay alone.
  6. **Status refresh** happens when the close-out screen is opened, one payer per request from the browser, and once a day from the cron for yesterday's charging rows.
  7. **Automatic close-out (Johnny, 2026-09-26).** The PIN is the authorization, so nobody has to press anything for a member who crossed the line. On the tick at `TAB_AUTO_HOUR` ET (20, i.e. 8 PM, after the last class) the cron opens a close-out for everyone due by the $5 / 28-day rule and works through it, `TICK_PAYER_BUDGET` (3) payers per tick so one invocation stays well inside the subrequest limit, continuing on the following ticks until done. On every tick it also continues an unfinished close-out and re-reads yesterday's charging rows so "Paid" appears without a tap. A row that throws keeps the error in its detail and is retried next tick; a row the state machine flagged for a person is left alone until a person acts. Each run that did anything writes a `sync_log` row (`job = 'tab'`), and `/health` shows `lastTabRun` and `lastTabOutcome`. Blank `TAB_AUTO_HOUR` turns the automatic run off; the button and the review screen stay either way, for removing a wrong line before 8 PM, charging early, retrying, or Charged at POS.

#### Card on file (verified 2026-09-25)

Where cards get saved: the flag is `chargeSnapshot.payment_method_options.card.setup_future_usage`. The top-level `chargeSnapshot.setup_future_usage` is always null; ignore it. The flag was `off_session` on 27/27 live funnel payments, 4/4 payment-link payments and 5 of 35 invoice payments. Funnels (founding deposits, Foundations sign-ups) and payment links (intros) are where cards get saved; later invoices and POS sales reuse the saved method. Reuse is proven, including Link wallet cards, on four named members each charged again by invoice and at the POS with no card present. Across the last 73 live succeeded non-zero payments, 50 contacts have a card with a Stripe customer and payment method.

**Lookup rule:**
1. `GET /payments/transactions?altId={location}&altType=location&contactId={payer}`. Consider only `status = succeeded`, `liveMode = true`. Test-mode card ids fail in live mode ("No such paymentmethod … a similar object exists in test mode").
2. Take the most recent whose `entitySourceType` is `invoice`, `funnel` or `payment_link`. `GET /payments/transactions/{id}?altId=…&altType=location` gives `chargeSnapshot.customer` (`cus_…`), `chargeSnapshot.payment_method.id` (`pm_…`), `card.brand`, `card.last4`.
3. A `point_of_sale` transaction counts only if its payment method id also appears on one of those three kinds. A card tapped at the desk may not be saved.
4. When one card has several payment method ids, use the one on the most recent successful charge.
5. No usable card: `skipped_no_card`, purchases stay open, `tab_flags` row set so the kiosk hides the drink row until staff clear it.

#### Close-out, per payer (one Worker request)

Each step writes its result to the `closeout_payers` row before the next step runs, so a crash at any point resumes safely and never double-charges:

1. **`pending`, no schedule id:** check for a stuck earlier attempt: `GET /invoices/schedule?altId=…&altType=location&search=<invoice_name>`. `search` matches any part of the name, so **filter the results for an exact name match** before adopting one. Deleted schedules do not appear. If one matches, save its id, set `schedule_created`, go to step 5.
2. **Contact details.** `GET /contacts/{payer}` for name, email and phone (D1 holds none of these, by design). Missing email or phone: `skipped_missing_contact`, purchases stay open, stop.
3. **Card on file**, per the lookup rule. Save brand, last 4, source on the row.
4. **Create the schedule.** `POST /invoices/schedule` with `altId`, `altType: "location"`, `name: <invoice_name>`, `contactDetails: { id, name, phoneNo, email }` (all four required), `schedule: { executeAt: "YYYY-MM-DDTHH:mm:ssZ" }` (that exact format, **no milliseconds**, or 422), `liveMode: true`, `businessDetails: { name: "Brazilian Top Team Bridgewater" }`, `currency: "USD"`, `discount: { type: "percentage", value: 0 }`, `items` one per line with `name`, `currency`, `amount` (dollars), `qty`, `productId`, `priceId`, `type: "one_time"`. Save the returned id immediately: `schedule_created`.
5. **Auto-pay on and activate, once.** Re-POSTing this has not been tested and will not be on a live card, so treat it as **not idempotent**: first `GET /invoices/schedule/{scheduleId}` and, if it is already active with auto-pay, skip the POST. Otherwise `POST /invoices/schedule/{scheduleId}/schedule` with `altId`, `altType`, `liveMode: true`, `autoPayment: { enable: true, type: "saved_card", paymentMethodId, customerId, card: { brand, last4 } }`. `type` must be exactly `"saved_card"`; `"card"`, `"stripe"` and empty all return 422. State `autopay_on`; mark that payer's purchases `invoiced` with `closeout_payer_id`.
6. **Status, on demand.** `GET /invoices/?altId=…&altType=location&contactId={payer}` finds the generated invoice (its `scheduleId` matches). `status` moves from `sent` to `paid` when the card is charged. Record `invoice_id` and `paid`. **The charge time is not fixed**: on the test it landed about ten hours after `executeAt`, before the due date. So `sent` is pending through the end of the day after the charge day (ET), and only an invoice still unpaid after that, or one that reads `void`, `failed` or `cancelled`, is set `failed`. A failed charge re-opens nothing automatically; staff see it and use Charged at POS or Johnny decides.

**Observed (2026-09-25), pinned in the step 6 fixtures:** the schedule create body has no due-date field. GHL set `issueDate` to midnight ET of the `executeAt` day and `dueDate` to 23:59:59.999 ET the same day. The invoice is generated at `executeAt`. **What the member actually receives (read from the test contact's conversation on 2026-09-26): one email at `executeAt`, GHL's "Invoice auto payment information" template ("a payment of $X is due on <date>"), and one email after the charge, the receipt. No SMS, and no "Invoice received" message.** The templates are GHL's built-in ones and cannot be edited in this account. The saved-card charge lands sometime on the `executeAt` day, not at `executeAt` and not only at the due date. `executeAt` is set five minutes after the close-out.

**Resume rules, as built.** A schedule GHL returns is treated as active when it reads `status: active` or `autoPayment.enable: true`, inactive on `draft`, `inactive`, `scheduled` or `enable: false`, and **unknown otherwise; an unknown schedule is left alone and the row is flagged for a person**, because a second activation is the failure that cannot be undone and a missed one can be closed at the POS. The response shapes for transactions, schedules and invoices are read tolerantly (a list bare or under `data`, `transactions`, `schedules`, `invoices`; a card under `chargeSnapshot.payment_method.card`) because they were observed, not documented. **The first live close-out should be one payer, Johnny, watched on the staff page.**

#### Allowed GHL calls, exhaustively

| Method | Path | Why |
|---|---|---|
| GET | `/contacts/` | roster sync (existing) |
| GET | `/locations/{id}/customFields` | field ids (existing) |
| PUT | `/contacts/{id}` | rollup fields, `checkin_last_at`, `purchase_pin_link` |
| GET | `/contacts/{id}` | payer name, email, phone for the invoice |
| GET | `/payments/transactions`, `/payments/transactions/{id}` | card on file |
| GET | `/invoices/schedule` | find a stuck schedule by name |
| GET | `/invoices/schedule/{id}` | is it already active, before step 5 |
| POST | `/invoices/schedule` | create the tab invoice |
| POST | `/invoices/schedule/{id}/schedule` | auto-pay on the saved card |
| GET | `/invoices/`, `/invoices/{id}` | charge status |

No refunds, no voids, no deletes, no other write. `test/write-scanner.test.js` enforces exactly this table.

#### Johnny's setup tasks for §15.3

1. Done: `BTT Check-In` integration scopes widened (`payments/transactions.readonly`, `invoices.readonly`, `invoices/schedule.readonly`, `invoices/schedule.write`).
2. Done: contact field `purchase_pin_link` (key `contact.purchase_pin_link`), and the published workflow "Check-In: Purchase PIN setup link" (trigger: Contact Changed on that field; action: SMS with the link; re-entry on). An If/Else "field is not empty" guard is being added, because the trigger fires on any change.
3. What the member receives at close-out, verified 2026-09-26 by a Claude in Chrome pass over the live account: **one email** at `executeAt` from the "Auto payment information" template ("$X is due on <date>", i.e. an upcoming auto-debit notice), then the receipt email after the charge. No SMS. The templates are GHL's built-in ones and cannot be edited here. The switches live at Payments → Invoices → Settings → Notifications → Customer Notifications and each applies to **every invoice in the account**; there is no per-schedule notification option in the UI. Receipts are a separate switch (Payments → Settings → Receipts) and are unaffected. **Johnny's decision (2026-09-26): one communication per charge.** "Auto payment information" is turned **off** account-wide (Payments → Invoices → Settings → Notifications → Customer Notifications); receipts stay on. A tab close-out then produces one email, the receipt after the charge. Known trade: any other auto-pay invoice in the account also loses the advance notice (about 40 other invoices exist since July; which use auto-pay was not established). Whether the schedule create body accepts a notification flag is unknown: this container cannot reach the GHL API docs. **Done 2026-09-26**, by a Claude in Chrome pass: "Auto payment information" off, saved, confirmed off after reload; "Enable automatic sales receipts for payments" confirmed on. The other seven switches were left as found: Invoice received on, Estimate received on, Invoice payment successful off (SMS only; its email is the receipt), Invoice payment failed on, Auto payment amount changed on, Auto payment failed on, Payment schedule received on. "Invoice received" and "Payment schedule received" are on, yet the $0.50 test contact received neither message for a scheduled invoice, so the expectation is one email. If a live close-out ever produces a second message, "Invoice received" is the switch to look at.
4. Member agreement: a clause authorizing tab purchases to be charged to the card on file, saying they will get a receipt by email after each charge, with nothing to do.
5. `wrangler secret put PIN_PEPPER` (a long random string).
6. Run `src/db/migrations/004_tab.sql` before the deploy that carries the tab.
7. Confirm the $0.50 test charged. Step 6 waits on this.
8. Stock the cooler.

#### Build order for §15.3

1. **Verify platform limits first:** Cloudflare's current per-request subrequest limit and CPU limit on this plan, whether D1 queries count toward it, and WebCrypto HMAC-SHA256. Record what was found, and how, in `STATUS.md`. This container's network proxy blocks the Cloudflare docs; if it still does, say so and record the numbers used as unverified.
2. Migration 004, `hasTabTables`, `tab-items.json` loading and validation, `TAB_*` config. A pending migration or empty `TAB_ITEMS` hides everything and never touches check-in.
3. PIN: HMAC hashing, setup-token flow with the 10-minute limit, the `/pin` setup page, per-member lockout, kiosk-wide failure log, staff open-setup and clear-lockout. `purchase_pin_link` added to `requiredFieldKeys`. Tests for hashing, constant-time compare, expiry, single use, the 10-minute limit and lockout edges.
4. Kiosk drink row and online-only purchase recording, with the eligibility rule (adult, no kids program, no no-card flag). Tests for the kids exclusion, the flag, and the failure copy.
5. Staff: tonight's tab, void, member tab, PIN activity, no-card clear.
6. Close-out: review screen with the $5 / 28-day rule and per-payer card status, `closeout_payers` state machine, one payer per request, resume, Charged at POS, status refresh. Fixture tests, no network, per §9 item 11. (Built 2026-09-25 after the $0.50 test settled.)
7. `STATUS.md` and the deploy commands.

**Noted, not part of this work:** the nightly rollup in `src/rollup.js` is not batched and will hit the same 50-call limit as membership grows. Fine today; flagged in `STATUS.md`.

#### Later phases (do not build yet; build Phase 1 so these slot in)

- **Phase 1b, kids billed to a parent.** The roster sync reads a contact custom field `payer_contact_id` on each kid (the btt-ops side creates and fills it). A kid with a payer sees the drink row; the PIN pad asks for the **parent's** PIN; the purchase is recorded with `buyer` = kid and `payer` = parent. A kid with no `payer_contact_id` never sees the drink row. The 14-year-old in the adult class becomes eligible here, billed to the parent. The waiver nudge (§15.1) should also go to the payer here.
- **Phase 2, merchandise.** A "Shop" button on the kiosk home screen. Items come from a GHL product collection rather than `tab-items.json`, including variants (sizes) and stock. A parent who has already checked a kid in picks an item and size, enters their PIN, and it goes on the same tab. Keep item handling data-driven so Phase 2 swaps the source, not the flow.
