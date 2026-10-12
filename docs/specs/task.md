# Task Status — Which Tree Falls First

Last updated: 2026-09-12

**Legend:** ✅ Done · 🟡 Partial · ⬜ Not started

| Phase | Task | Status |
|---|---|---|
| 0 | T1 Backend, database, storage | ✅ |
| 0 | T2 Seed data engineered for the demo | ✅ |
| 1 | T3 Resident submission flow | ✅ |
| 1 | T4 Location resolution | ✅ |
| 2 | T5 Image-aware severity pipeline | ✅ |
| 2 | T6 Duplicate detection | 🟡 |
| 3 | T7 Live admin queue | ✅ |
| 3 | T8 Same-day bundling | ✅ |
| 3 | T9 Map view | ✅ |
| 3 | T10 Lifecycle and completion | ✅ |
| 4 | T11 Email and feedback | 🟡 |
| 5 | T12 Admin gate and abuse controls | 🟡 |

---

## Phase 0 — Foundation ✅

### T1 · Backend, database, storage ✅

Migrated from a client-only Vite SPA to Next.js 14 (App Router) so API routes,
pages, and file handling live in one app.

- Supabase PostgreSQL via `pg`, schema applied idempotently on first query
- Tables: `requests`, `images`, `assessments`, `status_history`, `feedback`
- Additive migrations via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- Repository layer — every query lives there; nothing above it sees SQL
- Photo storage on disk **outside the web root**, served through
  `/api/images/[id]` so an auth check has somewhere to go
- Engine split into `classifyComplaint()` (persisted) and `scoreRequest()`
  (recomputed per read), because wait time changes daily and a stored final
  score would be wrong by morning

Files: `src/lib/db.ts`, `repository.ts`, `storage.ts`, `types.ts`,
`src/engine/scoring.ts`, `next.config.mjs`

### T2 · Seed data engineered for the demo ✅

28 records with **deliberate** spatial structure, plus a verification report
printed by `npm run db:reset`.

- Five clusters (North End, Quinpool, South End, Downtown) + one isolated outlier
- #1 ranked request sits in a tight cluster with **5 same-day candidates within
  500 m**, and those are *not* the next five in priority order
- #2 ranked request is **1.5 km away** — visibly unbundleable, exactly the case
  the brief describes
- One pre-linked duplicate pair, one unlinked near-duplicate pair
- Completed and rejected records, one with resident feedback
- All emails `@example.com`

Files: `src/seed/fixtures.ts`, `src/seed/run.ts`, `src/lib/geo.ts`

> Caught during this task: the first layout put #1 in a *spread-out* cluster with
> only one nearby candidate. The seeder's distance report exposed it and the
> geography was rebuilt.

---

## Phase 1 — Intake ✅

### T3 · Resident submission flow ✅

- Public `/report` form: name, email, location, description, optional photo
- Client-side preview via object URL (no base64 blowup on a 12 MB photo)
- Server validation with zod; field-level error display
- `POST /api/requests` accepts multipart, 12 MB cap, JPEG/PNG/WebP/HEIC
- Confirmation page at `/report/[reference]` with a reference number

**Deliberate choice:** the confirmation page shows **no risk score**. The ranking
is an internal dispatch decision; telling a resident their tree scored "Low"
reads as a safety judgement the tool is not making.

Files: `src/app/report/`, `src/components/ReportForm.tsx`,
`src/app/api/requests/route.ts`, `src/lib/intake.ts`

### T4 · Location resolution ✅

Four-step resolution, each falling back to the next:

1. **EXIF GPS** from the photo (`exifr`) — rejected unless plausibly in Halifax,
   so a holiday photo cannot poison the clustering
2. **Local Halifax gazetteer** — 28 streets, offline, street-centroid accuracy
3. **Live geocoder** — opt-in via `GEOCODER_URL`, off by default so a demo never
   depends on a third-party service
4. **Nothing** — stored anyway, flagged for a manual pin, excluded from distance
   maths

Files: `src/lib/geocode.ts`, `src/lib/exif.ts`

---

## Phase 2 — Intelligence

### T5 · Image-aware severity pipeline ✅

Photo analysis on the **same 0-100 scale and the same hazard vocabulary** the
text rules use, so fusion is arithmetic rather than translation.

Fusion policy (the interesting part):

| Situation | Score used | Review flag |
|---|---|---|
| No photo / analysis unavailable | text | unchanged |
| Photo and text agree (within 20) | higher of the two | unchanged |
| Photo shows **more** than described | photo | unchanged |
| Text claims **more** than the photo supports | text (the higher) | **flagged** |
| Photo resolves a vague description | photo | **cleared** |
| Photo unusable (not a tree, too dark) | text | **flagged** |

The fused score is never lower than the text score — under-ranking a described
hazard is the expensive mistake. Both source scores are shown side by side in
the admin UI so a disagreement is visible rather than averaged away.

Degrades cleanly: no API key, unsupported format, network failure or malformed
response all fall back to text-only. A submission never fails because an
analysis service was down.

Files: `src/lib/vision.ts`, `fuseClassification()` in `src/engine/scoring.ts`,
`src/components/PhotoAssessment.tsx`

### T6 · Duplicate detection 🟡

**Done:** scoring on three gated signals — proximity, recency, description
overlap (Jaccard over de-stopworded tokens). Weighted 30/20/50 toward
similarity, because a street-centroid geocode puts every address on a street at
the same point, so proximity alone would merge the whole street.
High-confidence matches are auto-linked at intake and drop out of the queue;
near-misses are returned as suggestions. Linked duplicates render on the detail
page.

**Remaining:**
- No admin UI to **confirm or reject** a suggested duplicate — suggestions are
  computed at intake and currently discarded rather than stored
- No unlink action for a wrong auto-link
- The seeded unlinked pair (`r-dup-windsor-a` / `-b`) is left as test material
  and is **not** yet detected retroactively — detection only runs on new intake

Files: `src/lib/duplicates.ts`, wired in `src/lib/intake.ts`

---

## Phase 3 — Admin operations

### T7 · Live admin queue ✅

Rebuilt on database reads. Summary cards, neighborhood/priority/review filters,
five sortable columns, empty state, mobile card layout, request detail with
scoring breakdown, hazard tags, status history, photos, and the printable
one-page poster.

Files: `src/app/admin/`, `src/components/QueueView.tsx`, `ComplaintTable.tsx`,
`FilterBar.tsx`, `RequestDetail.tsx`, `HazardPoster.tsx`

### T8 · Same-day bundling ✅

A crew going to Quinpool Road pays the mobilization whether they do one job or
four. This answers: given they are already there with hours left, what else
should they clear?

**The objective is not "the five nearest."** Nearest-five returns five cosmetic
prunings on one block while a High-priority tree sits 400 m away. Three things
are weighed at once — severity (final score), job hours, and travel time —
ranked by severity earned per hour of shift consumed, then discounted by a
proximity factor (400 m half-life) so a crew does not leave the area for a
marginally better job.

**Capacity is not the same as relevance.** A Critical removal is genuinely 5-6 h
of an 8 h shift, so often only one extra job actually *fits*. Returning a single
suggestion would be accurate and useless, so the plan reports two groups:

- **Scheduled today** — the prefix that fits the remaining hours
- **Follow-up trip** — the rest of the top 5, already justified by the crew
  being mobilized nearby

Greedy fill skips a job that does not fit and tries the next, so one long job
does not block two short ones behind it. Scheduled work is then re-ordered by
distance, because the crew is driving, not reading a ranked list.

Verified against the seed data:

| Anchor | In range | Recommendations | Queue ranks |
|---|---|---|---|
| Quinpool Rd (#1, Critical) | 6 | 5 @ 235–805 m | #6, #9, #13, #14, #16 |
| Agricola St (#2, Critical) | 9 | 5 @ 205–336 m | #5, #11, #15, #19, #20 |
| Dutch Village Rd (#3, isolated) | 1 | 1, none fit | #7 |

The recommendations are visibly *not* the next entries in the priority list,
and the isolated anchor correctly reports that it cannot be combined.

Files: `src/lib/bundling.ts`, `src/components/DayPlan.tsx`,
crew settings in `src/lib/config.ts`

### T9 · Map view ✅

Google Static Maps basemap with the symbology drawn over it.

- Streets come from Google; the markers do not. Priority colour, driving order
  and "today vs follow-up trip" are the whole point of the map and Google's
  marker parameters cannot express them
- `shared/map.ts` reproduces Google's Web Mercator projection exactly, so a pin
  lands on the right block rather than one over. Tested against great-circle
  distance in `shared/map.test.ts` — if the projection drifts, the pins move to
  the wrong street while still looking entirely plausible
- The API key never reaches the browser: the raster is proxied through
  `/api/map`, and each URL is HMAC-signed so the proxy cannot be used as free
  image hosting billed to HRM
- Fitted to the anchor and its recommended jobs, not to the whole open queue —
  one report across the harbour would shrink the cluster to a single dot
- Anchor, numbered scheduled jobs with route lines, dashed rings for follow-up
  work, faint dots for other open requests that fall inside the frame
- Round-number scale bar derived from the viewport's own ground resolution
- Degrades to the previous coordinate-only plot when no API key is configured

Files: `src/frontend/components/BundleMap.tsx`, `src/shared/map.ts`,
`src/backend/services/staticmap.ts`, `src/app/api/map/route.ts`

### T10 · Lifecycle and completion ✅

**Server (was already done):** full status enum, `status_history` with actor and
note, `setStatus()` writing row and history in one transaction so the audit
trail can never disagree with the row, `completed_at` handling, queue excludes
closed statuses.

**Added:** server actions and UI.

- Status dropdown across the open workflow
- **Mark complete** as a dedicated button, not one option in a select — it is
  the action a crew performs many times a day, and burying it makes the common
  path the slowest one
- **Reopen** reverts to whatever the request was *before* it closed, by walking
  `status_history` backwards. A job that was In Progress when someone
  fat-fingered the button goes back to In Progress, not to Submitted
- Completed work leaves the queue; the detail page switches to a closed state
  and hides the day plan (nothing left to schedule)

Every change is attributed to a single operations actor, since the console is
gated by one shared staff account — `status_history` already stores an actor per
row, so per-person identities are a one-line change rather than a migration.

Files: `src/app/admin/actions.ts`, `src/components/StatusControl.tsx`

### T11 · Email and feedback 🟡

**Done:** `feedback` table, feedback rendered on the detail page, seeded example,
resident email captured and stored, confirmation page promises the notification.

**Remaining:** no email is actually sent. Needs a transactional provider, two
templates (submission confirmation, completion notice), a feedback capture page
linked from the completion email, and delivery/bounce handling.

### T12 · Admin gate and abuse controls 🟡

**Done:** `/admin` is gated. One shared staff account (`ADMIN_USERNAME` /
`ADMIN_PASSWORD`, default `admin` / `admin`) and an HMAC-signed session cookie
that expires after a shift. The check runs in `src/middleware.ts` rather than in
each page, so it covers the server actions too — a page-level guard would leave
the status-change POSTs reachable. The resident form now sits at `/` and stays
public: reporting a hazard must never require an account.

**Remaining:** real per-person identities (the `status_history` actor column is
already there), rate limiting on public submission, and a moderation check folded
into the vision pass. `/api/images` is still unauthenticated — the resident
confirmation page needs it, so it wants a per-request token rather than a session.

---

## Database migration — SQLite to Supabase Postgres ✅

Replaced `better-sqlite3` with `pg` pointed at Supabase.

The dialect changes were mechanical (`?` -> `$1`, `AUTOINCREMENT` -> `SERIAL`,
`REAL` -> `DOUBLE PRECISION`, `INTEGER` flags -> `BOOLEAN`, `TEXT` timestamps ->
`TIMESTAMPTZ`, JSON text -> `JSONB`). The substantive change was that
`better-sqlite3` is **synchronous** and `pg` is **asynchronous**, so every
repository function became `async` and every call site had to be awaited —
pages, server actions, the intake pipeline and the seeder.

Also gained from the move: real transactions with `SELECT ... FOR UPDATE` in
`setStatus`, so two dispatchers closing the same job serialise; and a partial
index on `assessments(request_id) WHERE is_current`, which SQLite could not
express as cleanly.

**Verified against the live Supabase instance** (PostgreSQL 17.6, us-west-2):
schema created, 28 requests / 28 assessments / 12 images / 40 status rows / 1
feedback row seeded, and `/admin` plus a detail page render from Postgres with
the day plan, escalation notice and poster intact.

Two Supabase-specific bugs were found and fixed by doing this for real:

1. **`sslmode=require` broke every connection.** pg >= 8.23 treats it as
   `verify-full`, and a connection-string SSL mode overrides the `ssl` option
   object, so Supabase's chain failed verification regardless of
   `rejectUnauthorized`. `connectionSettings()` now strips it.
2. **`tsx` never loaded `.env.local`**, so the seeder could not see
   `DATABASE_URL`. The db scripts now pass `--env-file`.

Added `npm run db:check`: a diagnostic that names the IPv6 direct-host trap, the
TLS trap, and auth failures, and auto-discovers the Session pooler region when
the direct host is unreachable.

## Project structure

Restructured into explicit layers after Phase 3. `src/lib/` previously mixed
server-only modules (db, repository, vision, intake) with isomorphic ones
(types, geo), and components imported directly from the engine — there was no
boundary to enforce.

```
src/backend/    server-only: config, db, domain, services, seed
src/shared/     pure: types, scoring-config, geo
src/frontend/   components + styles
src/app/        Next.js routing only
```

**Rule:** `frontend/` never imports from `backend/`. Three violations existed
before the move and were fixed by relocating what the UI genuinely needs —
`WEIGHTS` and the `BundlePlan` types — into `shared/` rather than loosening the
rule. A grep for `@/backend/` under `src/frontend` returns nothing.

Deliberately **not** split into two deployed services: that would add CORS, two
dev servers and two deploy targets, and break the server components that read
the database directly — against the project's own "fast local execution, no
unnecessary infrastructure" constraint.

## Current state

```bash
npm install
npm run db:reset   # seed + print the verification report
npm run dev        # http://localhost:5177
```

- `/report` — public submission
- `/admin` — inspection queue
- `/admin/requests/[id]` — assessment + printable poster

Production build passes; TypeScript clean. Runs with an empty environment — no
API key, no network required.

## Suggested next step

**T11 (email)** now has something to fire on: `markCompleted()` is the hook
point. That closes the last loop in the original brief — resident submits, crew
completes, resident is notified and asked for feedback.

Then **T6's remaining half** (an admin UI to confirm or reject suggested
duplicates), and **T12's remaining half** — rate limiting on public submission
and moderation, now that the console itself is behind a sign-in.
