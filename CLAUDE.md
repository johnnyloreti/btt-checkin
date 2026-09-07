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

- The class is **pre-selected** from `schedule.json`: the class for this member's program whose start time is within the window: from **2 hours before** start to **20 minutes after** start, ET. (Changed from 45 / 15 by Johnny, 2026-09-06.) If exactly one matches, show it. Kids classes stack back to back on weekdays, so the program tag is what disambiguates; the window alone never decides. If two match (a member with two program tags, e.g. a 14-year-old approved for adult), show both as large buttons. If none match, show "No class right now" and a single button "Check in anyway" that records attendance with `class_name = "open mat / unscheduled"`.
- Tap CHECK IN. Success screen for 3 seconds, then back to home:

```
✓ You're checked in
Kids 6-9, 4:30 PM
Class #37
```

- Duplicate guard: same member, same class, same day = no second record, but still show the success screen. Never show an error to a student.
- Billing, membership status, balances, holds: **never shown on the kiosk.** If a member is flagged inactive in GHL, the kiosk still checks them in and writes `status_at_checkin = "inactive"` on the record. Staff see it. The student doesn't.
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

**Add student** opens the same search as the kiosk and records attendance with `method = "staff"`.

**Member lookup** (search any member): last 30 days of attendance, lifetime count, sync status. Read-only in V1.

No belt tracking, no notes, no promotions, no billing in V1. Those are V2.

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
- `GET /contacts/` and paginate fully. A contact is a member if it carries **any** of: the tag `founding-member`, or any tag starting with `foundations-` (currently `foundations-sept` and `foundations-oct`; future cohorts follow the same prefix and need no code change).
- `programs` from tags: each `program:*` tag that matches a key in `schedule.json` is added. Rules for contacts with no `program:*` tag:
  - has a `foundations-*` tag → `["adult"]`, no flag needed (Foundations is the adult program)
  - has only `founding-member` → `["adult"]` **and flagged** in `sync_log` detail by name, because founding members include kids and the kiosk cannot match them to a kids class until Johnny tags them.
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

**Allowed writes, exhaustively:** `PUT /contacts/{id}` with custom field values. That is the only write. Put a test in place that scans `src/` for any other method or endpoint and fails.

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

Vars in `wrangler.toml`:
- `GHL_LOCATION_ID = "ARCSFhJ0JlkcuzfZtyEJ"`
- `TZ = "America/New_York"`
- `MEMBER_TAGS = "founding-member"`
- `MEMBER_TAG_PREFIXES = "foundations-"`

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
9. Kiosk page: never contains an email, phone, or the string "billing" in rendered HTML.

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

Payment, billing state, waivers, class booking, reservations, QR codes, key tags, wallet passes, belt tracking, promotions, family accounts, member portal, push notifications, native apps, GHL Custom Objects, reading GHL calendars, any write to GHL other than the five rollup fields, anything that touches `btt-ops`.

---

## §14 Identifiers

- GHL location: `ARCSFhJ0JlkcuzfZtyEJ`
- Cloudflare account: `f02440d24727ce8e65f63b596c336c5e`
- Brand: near-black `#09090a`, bone `#f4f1e9`, gold `#e7c24c`, Oswald display, Inter body
- Timezone: `America/New_York`
