# Contracts for slice 2a "Job board + drag-to-assign" (parallel builders)

Nov 6, 2026 · written by the 2a foundation stage · companion to `docs/build-plan.md` (§4 rows
`farm.products`, `farm.jobs`, `farm.job_assignments` / `farm.job_products`,
`farm.data_rights_agreements`, `app.usage_events` and "Publish triggers on jobs, assignments and
pins"; §6 M2 2a; §7 testing; §8 the gesture risk, D8, D16, D17), `docs/contracts.md` (M0),
`docs/contracts-m1.md` (M1) and `docs/contracts-1f.md` (1f). All three are **still binding**
except where this page says otherwise. The decisions are rows **2a-1 … 2a-13** in
`docs/decisions.md` (§10 here).

Four builders work in parallel, each in its own git worktree off `claude/m2-2a`. This page is the
only agreement between them: who owns which paths, the ports and databases, the rules for shared
files, and every contract (the TypeScript files in `src/` plus the SQL of migration
`0008_m2a_job_board`). If a contract doesn't fit, **don't change it in place**: work around it
and say exactly what you need in your report. The integrator merges, resolves the one-line
conflicts, wires the shared pieces and owns the final layout.

**The target (cloud side; plan §6 2a done-when, unchanged).** With the wall and a phone side by
side, drag a spray job onto a field, then onto Sprayer 2 (unit **SP2**) and an operator. The
other screen updates in **under 2 s**. Proven by a Playwright spec with two browser contexts
under `next start` (the `wall` project; trusted touch through CDP `Input.dispatchTouchEvent`),
in **both directions** (the wall drags and the phone watches; the phone drags and the wall
watches), with `took < 2000` asserted and logged, as `e2e/field-panel.spec.ts` does for notes.
Plus everything else in plan §6 2a, each with tests: cards by crew coloured by status, a job from
a tapped field or from a text or phone request, the data-rights gate (D17), the usage report for
the Phase 2 gate, and the stretch customer request link.

**Out of scope (don't build):** 2b (the outbox, the Work Plan push, `job_operations`, morning
mode, go/no-go v1, `field_rain`, sensitive sites), 1g (kiosk hardening beyond what 2a needs,
`tracks_daily`, GPS retention, performance at 50 machines / 500 fields), 2c (drawing pins,
photos, the PWA, the IndexedDB outbox, offline maps), M3 (rates, invoices, costs), MD and
production (Supabase adapters, realtime RLS policies: the new `jobs` topic is noted for MD), 1e
(`tools/gis/**`, the `gis` schema), and the iPad/WebKit project (WebKit can't be downloaded
here).

---

## 1. Who owns what

| Key | Builds (brief, plan §6 2a) | Owns (may create and edit) | Next / stand-in | Dev database |
|---|---|---|---|---|
| **jobs-api** | The server core. The status machine, the automatic moves, summaries and conflict flags (the stub **function bodies** at the end of `src/domain/work-jobs.ts`, §4.3); the job queries; every `/api/v1/jobs/**` route (board snapshot with lanes, one job, create, patch with version, set the field by id or by the drop point, assign / unassign, status, cancel, reorder; §5) and `GET /api/v1/crew`; the **publish triggers** (§6) in `db/pending/jobs-api.sql` with their DB tests; a `job_action` usage event per job write through the usage writer (§7.7); the field detail's real open-jobs count; `deleteParty`'s new links. DB, unit and handler tests | the function bodies at the end of `src/domain/work-jobs.ts` (below the line "SIGNATURES FROZEN"; never the consts, types or labels above it), `src/domain/work-jobs.test.ts`, `src/db/queries/work-jobs*.ts`, `src/db/queries/crew*.ts`, `src/app/api/v1/jobs/**`, `src/app/api/v1/crew/**`, `db/pending/jobs-api.sql`; **plus (assigned, §1.2)** the open-jobs lines in `src/domain/fields.ts`, `src/db/queries/fields.ts`, `src/ui/fields/view-model.ts`, `src/ui/fields/fixtures.ts`, `src/app/admin/fields/[id]/page.tsx`, the `jobs` subscription in `src/ui/fields/detail-loader.ts`, the link list of `deleteParty` in `src/db/queries/parties.ts`, and the tests of §1.3 | 3121 / 4031 | `farm_dev_jobs_api` |
| **board** | The drag UI. The wall's jobs band (lanes, cards, "New job", the chips tray, collapse) and the phone's Jobs pill and sheet (§7.1); the job detail (wall popover, phone sheet view) with edit (rendering job-forms' `JobForm`), the status buttons (decision 2a-2) and cancel; the drag mechanics (dnd-kit, the map drop, the hover highlight, §4.5, §7.2); the realtime feed (snapshot, subscribe `jobs`, refetch on `updated` / `onResync`, poll every 15 s while disconnected, the pattern of `src/ui/fields/detail-loader.ts`); the done-when spec and e2e for the wall and phone layouts. Builds against the API contract with route mocks (`page.route`) until the merge; the integrator runs it against the real API | `src/ui/work/board/**` (the foundation's stubs `WorkBoard.tsx`, `WorkBoardProvider.tsx`, `store.ts` and `work-board.module.css` included: replace them, keep their exports and props), `e2e/m2a-board*.spec.ts` | 3122 / 4032 | `farm_dev_board` |
| **job-forms** | The new and edit job form (kind, business line, customer, field, window, crop year, planned qty / unit / acres, products with rate / unit / supplied-by, notes, request channel and requester); `GET /api/v1/job-options`; the field panel's **Jobs** tab (the field's open jobs with status, "New job here" for managers); `/admin/products` (list, add, edit, retire); the stretch request links (the `/admin/parties/<id>` section, the public `/r/<token>` form, decision 2a-9) | `src/ui/work/forms/**` (the stub `JobForm.tsx` included), `src/ui/fields/tabs/jobs*.tsx` (the stub included) and their tests, `src/app/api/v1/job-options/**`, `src/db/queries/{products,job-options,request-links}*.ts`, `src/app/admin/products/**` (the stub page included), `src/app/admin/parties/[id]/_request-links/**` (the stub section included), `src/app/r/**`, `e2e/m2a-forms*.spec.ts`, `e2e/m2a-request*.spec.ts` | 3123 / 4033 | `farm_dev_job_forms` |
| **rights-usage** | Data-rights agreements (D17, decision 2a-10): the queries, the `/admin/parties/<id>` agreements section with the document upload through the existing two-step storage grant, the `/admin/connectors` org rows (agreement status, "link to customer"), the shared gate predicate and its loader (already called in the four Deere per-org loops, §4.4), and the prospecting policy `mayUseCustomerData`. Usage events (decision 2a-11): the writer (already called from the pages and the PIN sign-in, §7.7), `POST /api/v1/usage` with the board's heartbeat component, the `/admin/usage` report and the `usage.prune` retention job | `src/connectors/deere/rights*.ts` (the stub included), `src/domain/data-rights*.ts`, `src/db/queries/{agreements,usage}*.ts`, `src/platform/usage/**` (the stub included), `src/ui/usage/**` (the stub included), `src/app/api/v1/usage/**`, `src/app/admin/usage/**` (the stub page included), `src/app/admin/parties/[id]/_agreements/**` (the stub section included), `src/jobs/usage-prune*.ts` (the stub included); **plus (assigned, §1.2)** the `deere-orgs` table of `src/app/admin/connectors/health-cards.tsx` and new files under `src/app/admin/connectors/` (`org-rights*.ts(x)` and its actions), `e2e/m2a-rights*.spec.ts`, `e2e/m2a-usage*.spec.ts` | 3124 / 4034 | `farm_dev_rights_usage` |

Existing test files follow the code they test, **except the ones §1.3 assigns** (that list wins).
A test of a file you don't own that your change breaks means you changed a contract: don't edit
that test, report it.

### 1.1 Integrator-owned (shared) files

Builders don't edit these; they list what to add in their report. The exceptions are the
**one-line registries, minimal mounts and assigned lines** of §1.2.

Everything not listed in §1 stays untouched, notably: `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `vitest.config.ts`, `playwright.config.ts`, `db/migrations/**`,
`src/db/schema/**`, `src/config.ts`, `src/jobs/registry.ts` (and its test), `src/jobs/{fleet-deere,deere-fields,deere-ops}.ts` (they already load the gate's rights, §4.4),
`src/connectors/deere/{client,orgs}.ts`, `src/connectors/deere/fields/{sync,client}.ts`,
`src/connectors/deere/ops/poll.ts` (they already call the gate), `src/ui/board/**`,
`src/app/board/**`, `src/app/m/**` (they already call the usage writer and mount the job board),
`src/ui/map/**` (`WarRoomMap.tsx`, `tap.ts`, `fit.ts`, the fleet layers), `src/ui/fleet/**`
(including `contract.ts`, which gained `workPlanCapable`, §5.6), `src/db/queries/fleet.ts`,
`src/ui/fields/**` other than the Jobs tab and the assigned lines (`FieldPanel.tsx`, `tabs.ts`,
`tab-registry.ts`), `src/platform/auth/**` (`types.ts`, `gate.ts`, `flows.ts` included),
`src/platform/realtime/**`, `src/platform/http/**`, `src/app/admin/layout.tsx`,
`src/app/admin/parties/**` other than the two sections, `src/app/admin/connectors/**` other than
rights-usage's assignment, `tools/seed/**`, `tools/import/**`, `src/sim/**`,
`tools/vendor-sim/**`, `e2e/support/**`, every M0/M1/1f e2e spec, `README.md`, `docs/**`,
`.github/**`, and **every contract file**:

`src/domain/work-jobs.ts` (the consts, types, labels and signatures; jobs-api fills the stub
bodies), `src/ui/work/contract.ts`, `src/ui/work/style.ts`, `src/platform/realtime/types.ts`,
`src/platform/auth/types.ts`, `src/ui/fields/tabs.ts`, `src/ui/fleet/contract.ts`,
`src/domain/{fields,farm,fleet,ids}.ts`, this file.

### 1.2 One-line registries, minimal mounts, assigned lines

Already in place (the foundation landed every seam, so nobody needs a new mount):

- `src/ui/board/BoardScreen.tsx`: `<WorkBoardProvider variant map>` around the wall's band and
  the map area; `<WorkBoard variant="wall" …>` as the row between the status strip and the map
  area; `<WorkBoard variant="phone" …>` inside the phone's map area; `<UsageHeartbeat route>`;
  `closeWorkBoardOverlays()` when a field, a machine or a pin opens; `onOpen` closing the
  others (§7.2). **No builder edits BoardScreen**: say in your report if you need another prop.
- `src/ui/fields/tab-registry.ts`: `jobsTab` (job-forms' file) is registered;
  `TAB_ORDER.jobs = 15` (right after Overview). The stub is **hidden** (`visible: () => false`;
  it flashes in the tab row only while a field's detail loads): job-forms removes `visible` (or
  makes it real) when the tab works.
- `src/app/admin/layout.tsx`: the nav has **Products** and **Usage**.
- `src/app/admin/parties/[id]/page.tsx`: `<AgreementsSection party>` (rights-usage) and
  `<RequestLinksSection party>` (job-forms) before the Delete card; both stubs render nothing.
  Each section decides itself whether it shows (customer parties).
- `src/app/board/page.tsx`, `src/app/m/page.tsx`: `recordUsage(usageOf(session, 'page_view',
  '/board' | '/m'))`; `src/platform/auth/flows.ts` `signInOperator`: `recordUsage({ kind:
  'pin_sign_in', … })` after a good PIN.
- The four Deere per-org loops call `orgReadAllowed`; the three Deere jobs load the run's
  rights with `loadOrgReadRights` (§4.4).
- `src/jobs/registry.ts`: `usage.prune` (daily `23 7 * * *`, `runUsagePrune` in
  rights-usage's `src/jobs/usage-prune.ts`).
- Stub route files answer **501** through `limitedJson` (`notBuiltYet`,
  `src/platform/http/not-built.ts`) for every `/api/v1/**` route of §5: replace them, keep the
  thin-file shape (`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `await ctx.params`, then
  your handler in a `handler.ts` next to it, as `src/app/api/machines/` does).

**Assigned lines (only these, in these files):**

- **jobs-api**: in `src/domain/fields.ts`, `FieldDetail.openJobs` becomes `{ count: number }`
  (the `placeholder: true` literal goes); in `src/db/queries/fields.ts` the real count (open
  statuses, §4.2) replacing the hard-coded zero; `src/ui/fields/view-model.ts` (the open-jobs
  line), `src/ui/fields/fixtures.ts` and `src/app/admin/fields/[id]/page.tsx` (the `openJobs`
  literal); in `src/ui/fields/detail-loader.ts` a `jobs` subscription next to the `fields` one
  that refetches when `updated.fieldIds` contains the open field (and on `invalidate`); in
  `src/db/queries/parties.ts` `deleteParty`'s inbound-link list gains jobs (customer,
  requested by), job assignments, data-rights agreements and request links, each with a plain
  message ("has 3 jobs").
- **rights-usage**: in `src/app/admin/connectors/health-cards.tsx`, the `deere-orgs` table only
  (an agreement column, "link to customer" for an org with no party); its data in new files
  under `src/app/admin/connectors/`.

### 1.3 Tests assigned by part

| File | Part | Owner |
|---|---|---|
| `src/ui/fields/view-model.test.ts` | the open-jobs case (line ~143) | jobs-api |
| `src/app/api/fields/handler.db.test.ts` | the open-jobs expectation (line ~56) | jobs-api |
| `src/db/queries/fields.db.test.ts` | the open-jobs expectation (line ~332) | jobs-api |
| `src/db/queries/fields.test.ts` | the open-jobs expectation (line ~50) | jobs-api |
| `e2e/field-panel.spec.ts` | the "open jobs" line (~329): the integrator changes it at the merge (an M1 spec); jobs-api says what it should read | integrator |
| `src/db/m2a-schema.db.test.ts`, `src/domain/work-jobs-vocab.test.ts`, `src/ui/work/contract.test.ts`, `tools/seed/work.db.test.ts`, `e2e/drag-helpers.spec.ts` | all (the foundation's) | integrator |
| `tools/import/data-transfer.db.test.ts` | the 2a round trip | integrator |
| `src/platform/auth/gate.test.ts` | the `/r/` cases | integrator (job-forms' `/r/` e2e covers the page) |
| `e2e/board.spec.ts` | the map controls' `exact: true` (the band's effect, §7.1) | integrator |
| `e2e/deere-fields.spec.ts`, `e2e/imagery.spec.ts` | the two wall taps the band moves (§7.1): if the band needs a spec change, the board builder writes it in its report and the integrator applies it | integrator |

---

## 2. Working rules

contracts-1f §2 holds, with the 2a base, branches, ports and databases:

- **Start from this commit** of `claude/m2-2a`. Make your worktree:
  `git worktree add ../fm-<key> -b m2a/<key> claude/m2-2a`, then in it `pnpm install`
  (offline from the store is fine; `@dnd-kit/core` 6.3.1 and `@dnd-kit/utilities` 3.2.2 are
  already in the lockfile), copy `.env` and `.env.local` from `/home/user/Farm-manager`, and copy
  `.data/storage` (the synthetic basemap) so your board has a basemap.
- **Your own ports and database** (§1): put the same four lines in **both**
  `.env.development.local` and `.env.production.local` of your worktree (contracts §2 explains
  why both):
  ```
  DATABASE_URL=postgres://farm_app:<FARM_APP_PASSWORD>@127.0.0.1:15432/farm_dev_<key>
  DATABASE_URL_MIGRATE=postgres://postgres:<DB_PASSWORD>@127.0.0.1:15432/farm_dev_<key>
  PUBLIC_URL=http://localhost:312x
  VENDOR_SIM_URL=http://127.0.0.1:403x
  ```
  (`<key>` with underscores: `farm_dev_jobs_api`, `farm_dev_board`, `farm_dev_job_forms`,
  `farm_dev_rights_usage`; ports jobs-api 3121 / 4031, board 3122 / 4032, job-forms 3123 / 4033,
  rights-usage 3124 / 4034), then `pnpm db:migrate` (creates `farm_dev_<key>`, applies
  0000-0008), `pnpm db:configure local`, `pnpm db:reset` (seeds the demo farm, the demo people
  and the job board's demo rows, §9), `pnpm db:pending` (if you have a `db/pending/<key>.sql`).
  `db:reset` drops every app schema and re-migrates without `db/pending`, so **re-run
  `pnpm db:pending` after every `db:reset`** (jobs-api: your triggers live there until the
  merge). `pnpm test:e2e` then builds and starts `pnpm pilot` on your port. DB tests need none
  of this: every test file gets its own clone of this checkout's test template,
  `farm_tpl_<12 hex of the migrations hash>` (already built for this commit), with
  `db/pending/*.sql` applied.
- **The shared container:** never `db:nuke`, `db:down`, `env:init`, `docker compose down`,
  never delete volumes, never `db:reset` or `db:migrate` the `postgres` database (only this stage
  and the integrator migrate it). `pnpm db:up` is allowed if the container stopped. If `docker
  info` fails, start the daemon (`(setsid nohup dockerd > /tmp/claude-0/dockerd.log 2>&1 &)`),
  wait, then `pnpm db:up`. Node 24: `export PATH=/opt/node24/bin:$PATH` in every shell (the
  default node is 22); for Playwright also
  `PLAYWRIGHT_BROWSERS_PATH=/tmp/claude-0/pw-browsers`.
- **Schema:** never edit `db/migrations/**` or `src/db/schema/**`. Migration 0008 (§3) should
  hold every table and column; extra schema goes in `db/pending/<key>.sql` (idempotent,
  `db/pending/README.md`). jobs-api's **triggers** go there by design (§6). Name any Drizzle
  mirror you'd need in your report and say why 0008 wasn't enough.
- **Dependencies:** never edit `package.json` or the lockfile. Added for 2a: `@dnd-kit/core`
  6.3.1 and `@dnd-kit/utilities` 3.2.2 (exact pins; peers React >= 16.8; React 19.3's
  `unstable_batchedUpdates` is still exported). `@dnd-kit/sortable` and `@dnd-kit/modifiers` are
  NOT installed: ask, with the exact version, if you need one.
- **Never edit another builder's paths.** Need something from one? Use its contract; if the
  contract lacks it, ask in your report. Builders compile against the foundation's stubs, so
  nobody waits for anybody.
- **Authorization:** every mutation (route handler or server action) and every private read calls
  `requireRole(min)` FIRST, on the server. Reads: `ROLE_FOR.viewPrivate` (viewer). Job writes:
  `ROLE_FOR.planJobs` (manager), except the status route: `ROLE_FOR.updateOwnJobStatus`
  (driver) **and** "own job" for anyone below `planJobs` (§4.3). `/admin/*`: `ROLE_FOR.admin`
  (manager). `/r/<token>`: no session; the token is the authorization (§5.5). The wall on its
  own is a **viewer** (D8): a drag on the wall needs a manager's PIN on it (demo: Amy Kovach).
  The browser's claims count for nothing; `viewer.canPlan` in the snapshot only hides controls.
- **E2E sessions:** `signInAs(context, role = 'viewer', baseURL?)` before the first navigation
  (contracts-1f §2): `'manager'` for drags and forms (the "E2E Manager" person session; on the
  wall project that is a person on the wall's browser, which is what a manager's PIN on the
  wall amounts to for the API), `'driver'` / `'operator'` for own-job status, `'viewer'` for
  the watching screen. Never call `unlockAdmin`.
- **Windows is the target**, **real farm data is never committed**, **vendor docs**: as
  contracts-1f §2. No live vendor calls.
- **Time:** inject the clock (`now` parameters, `ctx.now()`); never compare a fixed test clock
  with the real clock (commit `832bec9`). Farm days are `farmDate()` (America/Detroit).
- **Quality:** production TypeScript in the existing style (read neighbouring files), tests for
  everything, `pnpm lint`, `typecheck`, `test`, `test:db`, `build` and your e2e green, and the M0
  demo (`e2e/m0-demo.spec.ts`), `e2e/board.spec.ts`, `e2e/fleet-panel.spec.ts`,
  `e2e/field-panel.spec.ts`, `e2e/weather.spec.ts` and `e2e/layers.spec.ts` still passing.
  Commit on your branch with the attribution lines from the task; don't push.
- **Report:** what you built, files, how to see it (`pnpm dev` / `pnpm pilot` steps), what the
  integrator must add or change (pending SQL, assigned-line changes, contract additions, doc
  rows), open questions.

---

## 3. Database: migration `0008_m2a_job_board`

`db/migrations/0008_m2a_job_board.sql` (custom SQL, mirrored by `src/db/schema/{farm,app}.ts`;
snapshot `meta/0008_snapshot.json`; `pnpm exec drizzle-kit generate` says "No schema changes"),
applied to `postgres` and to the test template (`farm_tpl_<migrations hash>`). Every statement is
re-runnable (checked: running the file a second time over a migrated database changes nothing;
`pnpm db:lint` applies 0000-0008 from zero twice). Conventions as in M0/M1/1f: uuid PKs,
`timestamptz` UTC, `numeric` acres, `source` + `source_id` unique for outside and demo rows,
**demo id = `demoId(key)`** with `source = 'demo'`, CHECKs built from the TS const lists
(`src/domain/work-jobs.ts`, the `inList` pattern), constraint names as drizzle-kit writes them,
foreign keys added in a "when missing" block. No geometry columns. farm_app has
SELECT/INSERT/UPDATE/DELETE on all of it (default privileges, repeated). Checked by
`src/db/m2a-schema.db.test.ts`. **The jobs triggers are not in 0008** (§6).

### 3.1 Tables and columns

| Table | Columns (beyond `id` uuid PK, `created_at` / `updated_at` timestamptz default now()) | Keys, indexes, CHECKs | FKs (on delete) | Owner |
|---|---|---|---|---|
| `farm.products` | `kind` text (`PRODUCT_KINDS`: seed, chemical, fertilizer, fuel), `name` text, `epa_reg_no` text null, `restricted_use` bool default false, `unit` text (`PRODUCT_UNITS`: gal, qt, pt, floz, lb, oz, ton, bag, unit, kseed), `label_rules` jsonb default `{}` (2b's go/no-go input), `active` bool default true (retired = false), `source` default `'app'`, `source_id` | unique (`source`, `source_id`); CHECKs kind, unit, `name` 1-120 characters after trimming, `label_rules` an object | — | job-forms |
| `farm.jobs` | `kind` text (`JOB_KINDS`: plant, spray, harvest, haul, tillage, fertilize, scout, tile, repair, other), `business_line` text (`BUSINESS_LINES`: spraying, grain, trucking, store), `status` text default `'planned'` (`JOB_STATUSES`: requested, planned, assigned, pushed, in_progress, done, invoiced, cancelled), `status_changed_at` timestamptz default now(), `title` text null (≤ 80), `customer_party_id` uuid null, `field_id` uuid null, **`planned_window` tstzrange null** (plan §4's `window`, a reserved word in SQL; `[from, to)`, `src/db/range.ts`), `crop_year` int null, `planned_acres` numeric(12,4) null, `planned_acres_by_hand` bool default false, `planned_qty` numeric(12,2) null, `planned_unit` text null (`JOB_PLANNED_UNITS`: loads, bu, hours, tons, gal), `priority` int default 3 (1 urgent … 4 low), `sort_key` double precision default 0, **`version` int default 1**, `deere_work_plan_id` text null (2b), `notes` text null (≤ 4,000), `request_channel` text null (`REQUEST_CHANNELS`: text, phone, in_person, web_form), `requested_by_party_id` uuid null, `requester_name` text null (≤ 120), `requester_phone` text null (≤ 40), `request_link_id` uuid null, `cancelled_reason` text null (≤ 500), `created_by` / `updated_by` uuid null, `source` default `'app'`, `source_id` | unique (`source`, `source_id`); **`jobs_board_idx`** btree (`business_line`, `priority`, `sort_key`) where `status not in ('done', 'invoiced', 'cancelled')`; btree `field_id`, `customer_party_id`, `requested_by_party_id`, (`request_link_id`, `created_at`); CHECKs kind, business_line, status, planned_unit, request_channel, priority 1-4, version ≥ 1, crop_year null or 1950-2100, acres and qty ≥ 0, a window never empty, the text limits | `field_id` → fields **set null**; `customer_party_id`, `requested_by_party_id` → parties **restrict**; `request_link_id` → job_request_links **set null**; `created_by`, `updated_by` → app_users **set null** | jobs-api |
| `farm.job_assignments` | `job_id` uuid, `party_id` uuid null (a crew party: app_users is one-to-one with party), `machine_id` uuid null, `role` text default `'crew'` (`ASSIGNMENT_ROLES`: operator, crew), `planned_for` tstzrange null (the part of the job's window this row is on; null = all of it), `assigned_by` uuid null (no `updated_at`) | **one row per person per job** (unique `job_id, party_id` where party set) and **one per machine per job** (unique `job_id, machine_id` where machine set); btree `party_id`, `machine_id`; CHECKs a person or a machine, role, `planned_for` never empty | `job_id` → jobs **cascade**; `party_id` → parties **restrict**; `machine_id` → machines **restrict**; `assigned_by` → app_users **set null** | jobs-api |
| `farm.job_products` | `job_id` uuid, `product_id` uuid, `rate` numeric(12,4) null, `unit` text null (`RATE_UNITS`: gal_ac, qt_ac, pt_ac, floz_ac, lb_ac, oz_ac, ton_ac, unit_ac, kseed_ac, or totals gal, lb, ton, unit), `supplied_by` text default `'us'` (`SUPPLIED_BY`: us, customer) (no `updated_at`) | unique (`job_id`, `product_id`); btree `product_id`; CHECKs rate ≥ 0, unit, supplied_by | `job_id` → jobs **cascade**; `product_id` → products **restrict** | jobs-api (written through the job routes; job-forms' form sends them) |
| `farm.data_rights_agreements` | `party_id` uuid (the customer **org** party), `signed_on` date, `document_key` text null (a key in the private `uploads` bucket), `permitted_uses` text[] default `{}` (⊆ `PERMITTED_USES`: billing, agronomy, prospecting, landlord_sharing), `revoked_on` date null (counts while null), `notes` text null, `created_by` uuid null, `source` default `'app'`, `source_id` | unique (`source`, `source_id`); btree `party_id`; CHECKs the uses ⊆ the list, `revoked_on ≥ signed_on` | `party_id` → parties **restrict**; `created_by` → app_users **set null** | rights-usage |
| `farm.job_request_links` | `party_id` uuid (the customer), `token_hash` text (HMAC-SHA256 of the token under SESSION_SECRET; the token itself is never stored), `label` text null, `created_by` uuid null, `revoked_at` timestamptz null, `last_used_at` timestamptz null (only `created_at`) | unique `token_hash`; btree `party_id` | `party_id` → parties **restrict**; `created_by` → app_users **set null** | job-forms |
| `app.usage_events` | `at` timestamptz default now(), `farm_day` date (`farmDate(at)`), `kind` text (`USAGE_KINDS`: page_view, board_heartbeat, pin_sign_in, job_action, morning_run), `route` text default `''` (≤ 200), `app_user_id` uuid null, `device_id` uuid null, `actor_key` text (`'<device id or ->:<app user id or ->'` at write time, `usageActorKey`), `bucket_at` timestamptz (`at` floored to 5 minutes, `usageBucketStart`) (no `created_at`/`updated_at`) | **`usage_events_bucket_key`** unique (`actor_key`, `kind`, `route`, `bucket_at`): the writer inserts `on conflict … do nothing`; btree `farm_day`, `app_user_id`, `device_id`; CHECKs kind, route length, actor_key format, `bucket_at ≤ at` | `app_user_id` → farm.app_users **set null**; `device_id` → farm.devices **set null** (the first FKs from `app` into `farm`; `actor_key` keeps the bucket key unique after a person or device is deleted) | rights-usage |

**Ids.** App rows: `gen_random_uuid()`. Demo rows (§9): `demoId(key)`, `source = 'demo'`,
`source_id = key` (`job-<…>`, `product-<…>`, `agreement-halvorsen`; a demo job's assignments and
products `demoId('<job key>:assignment:<n>')` / `':product:<n>'`). e2e rows: `source = 'e2e'`
with deterministic ids, removed by the spec that made them (jobs cascade to their rows).

### 3.2 What 0008 deliberately leaves out

- **Publish triggers** (§6): jobs-api writes them in `db/pending/jobs-api.sql`; the integrator
  folds them into the next migration.
- **`farm.jobs.window` by its plan name** (reserved word): it is `planned_window`.
- **A crews table** (decision 2a-1: lanes are business lines).
- **A new `ingest.connector_orgs` status** for "blocked by the data-rights gate": the CHECK stays
  (connected, needs_approval); a blocked org is stored as needs_approval with
  `NO_AGREEMENT_DETAIL` (§4.4), and /admin/connectors reads the agreement state at render time.

### 3.3 Export and import (`tools/import/data-transfer.ts`, integrator-owned, already done)

`data:export` lists, in foreign-key order after the 1c tables: `farm.products` (source app or
import), `farm.job_request_links` (all; only the token's hash travels), `farm.jobs` (source app
or import; `planned_window` as `{ from, to }`; actors `created_by`, `updated_by`),
`farm.job_assignments` and `farm.job_products` (those of exported jobs; actor `assigned_by`),
`farm.data_rights_agreements` (source app or import; actor `created_by`), and
`app.usage_events` of **your own** people and devices only (`app_user_id` and `device_id` null
or of source `app`; actors both; **insert-only**: `on conflict do nothing`). Demo rows never
travel: the demo seed brings them back under the same ids, so your jobs that name a demo field,
machine, crew member or product still fit. `data:import` sets `app.jobs_publish = 'off'` for its
transaction (the triggers must honour it, §6) and publishes one `jobs`/`invalidate { event:
'updated', reason: 'changed' }` at the end. The round trip is tested in
`tools/import/data-transfer.db.test.ts` ("2a: …"). Cost to watch (rights-usage): a wall with an
operator signed in all day writes about 170 heartbeat rows a day; 400 days of a few screens is
some 10^5 rows in the file. Say in your report if you'd rather export daily summaries.

---

## 4. Domain contracts (`src/domain/work-jobs.ts`)

### 4.1 Naming (the scheduled-job collision)

`/api/jobs/[name]`, `src/jobs/**`, `ingest.job_runs` and `JOBS_SECRET` are the **scheduled-job
runner**. Farm work jobs are "work jobs" in code: `src/domain/work-jobs.ts`,
`src/db/queries/work-jobs*.ts`, `src/ui/work/**`; versioned HTTP under **`/api/v1/jobs/**`**
(plus `/api/v1/crew`, `/api/v1/job-options`, `/api/v1/usage`); the realtime topic **`jobs`**;
the SQL tables keep the plan's names (`farm.jobs`, …). Never put work-job code in `src/jobs/**`
(its lint and seam rules are for the runner). **No server actions for board writes** (status.md:
server-action refreshes delayed results 5-15 s); admin pages may use actions as today.

### 4.2 Vocabulary (frozen; additive changes through a contract change)

The lists of §3.1 with their labels (`JOB_KIND_LABELS`, `BUSINESS_LINE_LABELS`,
`JOB_STATUS_LABELS`, `JOB_PRIORITY_LABELS`, `JOB_PLANNED_UNIT_LABELS`, `REQUEST_CHANNEL_LABELS`,
`ASSIGNMENT_ROLE_LABELS`, `PRODUCT_KIND_LABELS`, `PRODUCT_UNIT_LABELS`, `RATE_UNIT_LABELS`,
`SUPPLIED_BY_LABELS`, `PERMITTED_USE_LABELS`, `USAGE_KIND_LABELS`), and:

- `BUSINESS_LINES` is in **lane order** (Spraying, Grain, Trucking, Store);
  `DEFAULT_BUSINESS_LINE[kind]` is a new job's lane (spray, fertilize, scout → spraying; haul →
  trucking; the rest → grain).
- `OPEN_JOB_STATUSES` (requested, planned, assigned, pushed, in_progress) are the board's cards
  and the field's open-jobs count; `CLOSED_JOB_STATUSES` (done, invoiced, cancelled);
  `isOpenJobStatus`.
- `JOB_PRIORITIES` 1-4, `JOB_DEFAULT_PRIORITY = 3`.
- Limits: `MAX_JOB_TITLE_CHARS` 80, `MAX_JOB_NOTES_CHARS` 4,000, `MAX_CANCEL_REASON_CHARS` 500,
  `MAX_REQUESTER_NAME_CHARS` 120, `MAX_REQUESTER_PHONE_CHARS` 40, `MAX_PRODUCT_NAME_CHARS` 120,
  `MAX_JOB_PRODUCTS` 20, `MAX_REORDER_JOBS` 200 (the CHECKs use the same numbers).
- `ACRES_DIFFER_FRACTION = 0.01` (decision 2a-5), `JOBS_TRIGGER_MAX_PAYLOAD_BYTES = 7_000`
  (§6).
- Request links: `REQUEST_LINK_MAX_PER_DAY = 20`, `REQUEST_LINK_TOKEN_BYTES = 16` (128 bits).
- Usage: `USAGE_BUCKET_MINUTES = 5`, `USAGE_HEARTBEAT_MS` (5 min), `USAGE_RETENTION_DAYS = 400`,
  `USAGE_REPORT_DAYS = 30`, `PHASE2_MIN_DAILY_CREW = 2`, `CREW_APP_ROLES` (driver, operator,
  manager), `GATE_SKIPPED_WEEKDAYS` ([0]: Sunday); `usageActorKey(deviceId, appUserId)`,
  `usageBucketStart(at)` (implemented, tested in `work-jobs-vocab.test.ts`).
- `JOB_SOURCE_APP = 'app'`, `JOB_SOURCE_DEMO = 'demo'`.

### 4.3 The status machine (decision 2a-3; signatures frozen, bodies by jobs-api)

```ts
interface JobActor { role: AppRole; ownJob: boolean; via?: 'person' | 'work_plan' | 'billing' }
type JobTransitionCheck = { ok: true } | { ok: false; reason: 'same' | 'not_allowed' | 'forbidden'; message: string };
checkJobTransition(from: JobStatus, to: JobStatus, who: JobActor): JobTransitionCheck
nextJobStatuses(from: JobStatus, who: JobActor): JobStatus[]            // in JOB_STATUSES order
autoJobStatus(status: JobStatus, job: { hasField: boolean; assignmentCount: number }): JobStatus
jobSummary(job: { kind, title, fieldName, plannedAcres, plannedQty, plannedUnit }): string
```

The stubs refuse every move, return none, keep the status, and return the title or the kind's
label. jobs-api implements, and tests **every (from, to, role, ownJob, via) combination**:

- Moves: requested → planned ("accept"); planned → assigned; assigned → pushed (**only `via:
  'work_plan'`**, 2b); assigned / pushed → in_progress; in_progress → done; done → invoiced
  (**only `via: 'billing'`**, M3); **cancelled from any status before done** (with an optional
  reason); **done → in_progress** (a manager fixing a mistake). Nothing else: an assigned job
  goes back to planned only by losing its last assignment (the automatic move below), and no
  job goes back to requested.
- Who (decision 2a-2): `planJobs` (manager and up) may make any allowed move; below that,
  `updateOwnJobStatus` (driver, operator) only **on their own job** (`ownJob`: their party is on
  one of its assignments) and only assigned / pushed → in_progress and in_progress → done;
  viewers nothing. A refused move by role is `'forbidden'` (the route answers 403), a move the
  machine doesn't have is `'not_allowed'` (422), the same status `'same'` (422).
- **Automatic moves on write** (`autoJobStatus`, applied by every write that changes the field
  or the assignments, in the same transaction): a requested or planned job that has a field and
  at least one assignment becomes **assigned** (accepting a request by assigning it); an
  assigned job that loses its last assignment goes back to **planned**; anything else keeps its
  status. `status_changed_at` moves with every status change.
- `jobSummary`: "Spray · Halvorsen Corwin 80 · 78 ac" (kind, field, acres or qty + unit), used
  when `title` is null.

### 4.4 The data-rights gate (D17, decision 2a-10; `src/connectors/deere/rights.ts`)

```ts
interface OrgReadRights { mode: Mode; homeOrgId: string | null; agreedOrgIds: ReadonlySet<string> }
orgReadAllowed(orgId, listing: readonly { id; member? }[], rights: OrgReadRights | null | undefined): boolean
loadOrgReadRights(ex: Executor, mode: Mode, homeOrgId: string | null): Promise<OrgReadRights>
blockedOrgAccess(org): DeereOrgAccess          // status needs_approval, detail NO_AGREEMENT_DETAIL
NO_AGREEMENT_DETAIL                             // the log / stored-row text
```

- **Rule:** the home org (`deereHomeOrg(rights.mode, rights.homeOrgId, listing)`) is always
  read; any other org is read **in sandbox and live only when** it is in `agreedOrgIds` (its
  customer party has an unrevoked agreement); **in sim and replay always** (reported, not
  enforced: the demo's customers are fake). No rights = allowed (tests, tools).
- **Where it is called** (the foundation already calls it; the call sites are integrator-owned):
  `DeereClient.pollLocationsWithOrgs(cursor, { rights })` (a refused org goes into the run's org
  list as `blockedOrgAccess(org)`, which fleet.deere stores), `DeereFieldsRun.orgs()`
  (`DeereFieldsRunOptions.rights`, logged and skipped), `DeereFieldsApi.connectedOrgs()`
  (`new DeereFieldsApi(client, { rights })`; only the contract tests use it), and
  `pollDeereOperations` (`OpsPollDeps.rights`, `skipOrg(org, NO_AGREEMENT_DETAIL)`). The jobs
  fleet.deere, deere.fields and deere.ops call `loadOrgReadRights(ctx.pool, mode,
  cfg.DEERE_HOME_ORG_ID ?? null)` once per run. **CNH companies are machines only: not gated.**
- **rights-usage builds:** `loadOrgReadRights` (one query: unrevoked agreements joined to the
  org → party links the way `customerOrgParty` resolves them, **read-only**: the
  `('deere', 'party', <org>, <org>)` ref, else the client party the org's farms share),
  `orgReadAllowed`, and `/admin/connectors`' org rows: "agreement on file" or "no agreement:
  blocked in live" per customer org, and for an org with no party yet a "link to customer"
  control that writes the same `('deere', 'party', <org>, <org>)` external ref (`upsertExternalRef`)
  so an agreement can be recorded before the first sync. Tests: the predicate over every mode ×
  home/agreed/revoked/unlinked, the loader against seeded agreements and refs, each loop in sandbox
  with a refused org (its data is not read, the others are), sim unchanged.
- **Prospecting:** `mayUseCustomerData(agreements, use: PermittedUse): boolean` in
  `src/domain/data-rights.ts` (a pure policy plus tests: an unrevoked agreement naming the use;
  none = no). No prospecting code exists yet (M4).

### 4.5 Drag semantics (decision 2a-4)

Drags start **only from job cards** (dnd-kit; never from the map, never from chips). A card
dropped:

- **on the map over a field**: `PUT …/field` with `{ version, fieldId }`, the field found with
  `map.queryRenderedFeatures([x, y], { layers: ['fields-fill'] })[0].properties.id` at the drop
  point (container coordinates; the point must be on the map canvas:
  `document.elementFromPoint(x, y)?.closest('.maplibregl-canvas-container')`). When the fields
  layer is hidden or the map is below z8 (no field tiles), the client sends `{ version, at: {
  lng, lat } }` (`map.unproject`) and the server picks the field whose **current** boundary
  contains it, or answers 422 "not on a field". **A drop never opens the field panel.** With no
  customer yet, the customer defaults to the field's farm's client party; planned acres follow
  §4.6; crop year §4.6.
- **on a machine chip**: `POST …/assignments` `{ version, machineId }`: fills the job's row that
  has a person but no machine, else a new row.
- **on a person chip**: `{ version, partyId }`: fills the row that has a machine but no person,
  else a new row ("SP2, then an operator" is one row: SP2 run by Dale). Role `operator` when the
  row has a machine, else `crew`.
- **anywhere else**: nothing changes; the card springs back.

An assignment is removed with an × on its chip in the card (manager): `DELETE
…/assignments/<id>?version=N` (the whole row) or `&part=machine|person` (one side; a row left
with neither is deleted). A **down** machine still takes a drop; its chip and the card show
"down" (flag `machine_down`). The same person or machine on two open jobs with overlapping
windows is **allowed** and flagged on both (`double_booked`, `alsoOn`), never blocked. A machine
already on the job is a no-op (200, same version).

### 4.6 Planned acres and crop year (decisions 2a-5, 2a-6)

- When the field is set (create, PATCH `fieldId`, PUT field), `planned_acres` = the field's
  `farm.current_boundaries.acres` unless `planned_acres_by_hand`; changing the field
  re-snapshots unless typed by hand. A number in a body sets them by hand; `plannedAcres: null`
  in a PATCH hands them back to the boundary. Later boundary changes don't move a job's acres;
  the card shows the boundary acres beside them when they differ by more than 1 %
  (`acres_differ`). Billing acres stay D16's (M3).
- `crop_year` is set with the field from **`fieldGrowingYear`** (`src/db/queries/operations.ts`,
  D23), else `currentCropYear(now)`; a manager may pick the other synced season
  (`cropSeasonsToSync(now)`, offered by `GET /api/v1/job-options`). No second date rule: the
  Aug 1 question stays D23's.

### 4.7 Optimistic concurrency (decision 2a-7)

Every job write sends the `version` it saw. The write is a compare-and-set on the job row in the
same transaction as the child change:

```sql
update farm.jobs set version = version + 1, updated_at = now(), updated_by = $who, …
 where id = $1 and version = $2
```

No row updated: the job exists → **409** `JobConflictResponse { error, job }` (the current job,
the same shape as GET) and nothing changed; it doesn't → 404. Assignment and product writes bump
the job's version too (so two managers assigning the same job conflict). Reorder is one
transaction over the listed jobs; one stale version fails it all (409 with that job). The client
refetches and says `JOB_CONFLICT_MESSAGE` ("Changed on another screen; try again"). Same pattern
as the notes 409 (`src/app/api/fields/handler.ts`).

---

## 5. HTTP API (`src/ui/work/contract.ts`)

### 5.1 Rules for every route

Thin `route.ts` (`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `await ctx.params`) calling a
framework-free handler, in this order (`src/app/api/machines/handler.ts`): `requireRole` first
(`authErrorResponse` → 401/403 `{ error, status, required }`); for writes
`isSameOriginRequest` (403 `{ error: 'cross-site request refused' }`), `application/json`
(415), `readLimitedText(req, JOB_BODY_MAX_BYTES)` (413), `JSON.parse` (400), the zod schema
(400 `{ error }`), `isUuid` on path ids (404); then the query; a database failure is a logged 503.
Every answer through `limitedJson(body, { status, headers: { 'cache-control': 'no-store' } },
{ route })`. Errors are `{ error: string, … }` with no error codes, except 422's `reason`.
**No route publishes realtime** (the triggers do, §6). Each job write records a `job_action`
usage event (`recordUsage(usageOf(session, 'job_action', '<route pattern>'))`, outside the
write's transaction, never failing it).

### 5.2 Routes

| Method and path | Role | Body (zod) | Answers |
|---|---|---|---|
| `GET /api/v1/jobs[?fieldId=<uuid>]` | viewer | — | 200 `BoardSnapshot` (`boardSnapshotSchema`): every open job plus jobs that went done on the current farm day, in the four lanes in `BUSINESS_LINES` order (empty lanes included), each lane ordered by priority, then window start (no window last), then `sort_key`, then `created_at`; `viewer { role, partyId, canPlan }`. With `fieldId`: that field's jobs only (the Jobs tab) |
| `POST /api/v1/jobs` | planJobs | `createJobBodySchema` | 201 `JobResponse`; 404 an unknown field, customer or product id; 422 |
| `GET /api/v1/jobs/<id>` | viewer | — | 200 `JobResponse`; 404 |
| `PATCH /api/v1/jobs/<id>` | planJobs | `updateJobBodySchema` | 200 `JobResponse`; 409 `JobConflictResponse`; 404; 422 |
| `PUT /api/v1/jobs/<id>/field` | planJobs | `setJobFieldBodySchema` | 200; 409; 404; 422 `{ error: 'not on a field', reason: 'not_on_field' }` |
| `POST /api/v1/jobs/<id>/assignments` | planJobs | `assignJobBodySchema` | 200 (no-op when already on: same version); 409; 404 unknown machine or person; 422 `reason: 'machine_retired'` |
| `DELETE /api/v1/jobs/<id>/assignments/<aid>?version=N[&part=machine\|person]` | planJobs | — | 200; 409; 404 |
| `POST /api/v1/jobs/<id>/status` | updateOwnJobStatus (+ own job below planJobs) | `setJobStatusBodySchema` | 200; 409; 403 not your job / not for your role; 422 `reason: 'not_allowed' \| 'same'` |
| `POST /api/v1/jobs/<id>/cancel` | planJobs | `cancelJobBodySchema` | 200; 409; 422 `reason: 'closed'` (done, invoiced or cancelled) |
| `POST /api/v1/jobs/reorder` | planJobs | `reorderJobsBodySchema` | 200 `BoardSnapshot`; 409 (the first stale job); 422 a job not in that lane |
| `GET /api/v1/crew` | viewer | — | 200 `CrewResponse`: parties of kind person with role crew, by name, with `appUserId`, `initials`, `appRole` (null = no sign-in) and `active` (e2e principals show in e2e databases) |
| `GET /api/v1/job-options` | viewer | — | 200 `JobOptionsResponse`: active products, customer parties (role customer, kind org), active fields with a current boundary (name, farm, acres, customer), `cropYears` = `cropSeasonsToSync(now)`, `currentCropYear` |
| `POST /api/v1/usage` | viewer (any session) | `usageHeartbeatBodySchema` `{ route: '/board' \| '/m' }` | 200 `{ recorded }` (false when the bucket already had it) |

Owners: `/api/v1/jobs/**` and `/api/v1/crew` jobs-api; `/api/v1/job-options` job-forms;
`/api/v1/usage` rights-usage. URL helpers: `jobsUrl`, `jobUrl`, `jobFieldUrl`,
`jobAssignmentsUrl`, `jobAssignmentUrl(id, aid, version, part?)`, `jobStatusUrl`,
`jobCancelUrl`, `JOBS_REORDER_URL`, `CREW_URL`, `JOB_OPTIONS_URL`, `USAGE_URL`.

### 5.3 The job view (`jobViewSchema`, frozen; additive only)

`JobView { id, version, kind, businessLine, status, statusChangedAt, title, summary,
field { id, name, farmName, boundaryAcres } | null, customer { id, name } | null,
window { from, to } | null, cropYear, plannedAcres, plannedAcresByHand, plannedQty,
plannedUnit, priority, sortKey, notes, request { channel, partyId, name, phone, viaLink } | null,
cancelledReason, deereWorkPlanId, assignments: JobAssignmentView[], products: JobProductView[],
flags: JobFlag[], createdAt, updatedAt }`, with `JobAssignmentView { id, role, machine
{ id, unitNo, kind, status, workPlanCapable } | null, person { partyId, name, initials } | null,
plannedFor, alsoOn: { jobId, summary }[] }`, `JobProductView { id, productId, name, kind, rate,
unit, suppliedBy, restrictedUse, epaRegNo }` and `JOB_FLAGS` (no_field, machine_down,
double_booked, acres_differ, restricted_use). Times are ISO with offset. The board and the forms
render only from these; route mocks build them (board's e2e until the merge).

### 5.4 The 409 shape

```json
{ "error": "Changed on another screen; try again", "job": { …JobView, the current one… } }
```

`jobConflictResponseSchema`. The client replaces its copy with `job` and shows the message.

### 5.5 The request link (`/r/<token>`, job-forms, decision 2a-9)

`/r` is in `PUBLIC_PAGE_PATHS` (`src/platform/auth/gate.ts`): `/r/<token>` opens with no
identity (GET and POST; `/rx`, `/requests` still need one; tested in `gate.test.ts`). The page
(`src/app/r/[token]/**`) finds the link by `HMAC(SESSION_SECRET, 'job-request-link', token)`
(a new purpose next to `hashCode`'s, in job-forms' own file), refuses a revoked or unknown token
with the same "this link doesn't work any more" page, shows a small form on GET (what, where,
when, notes, name and phone) and on POST creates a **requested** job (`request_channel
'web_form'`, `requested_by_party_id` = the link's party, `request_link_id`, `source 'app'`;
inserted directly in job-forms' query: the triggers publish it), at most
`REQUEST_LINK_MAX_PER_DAY` per link per farm day (counted from `jobs.request_link_id` +
`created_at`), touching `last_used_at`. The token is 128 random bits, base64url
(`REQUEST_LINK_TOKEN_BYTES`), shown once when made. LAN-only until MD.

### 5.6 Machines for the chips (`src/ui/fleet/contract.ts`, already done)

The chips tray reads machines from `useFleetPanel()`'s shared feed (no second fetch).
`PanelMachine.workPlanCapable` (optional boolean, decision 2a-13) is true when the Deere sync
created the machine or it has a `('deere', 'machine', …)` external ref (`fleetPanelMachines`):
the chip's small "Deere" badge, so a manager sees that SP2 (a Samsara-gatewayed RoGator) won't
take a Work Plan.

---

## 6. Realtime (`src/platform/realtime/types.ts`)

| Topic / event | Payload | Published by | Subscribers do |
|---|---|---|---|
| `jobs` / `updated` (**new topic**) | `JobsUpdatedPayload { jobIds, fieldIds, machineIds, partyIds }`: ids only, each list deduplicated; `fieldIds` has the old **and** new field of every changed job (a card leaving a field updates that field too); machines and people from the changed assignment rows (old and new) | **only the jobs triggers** (jobs-api, `db/pending/jobs-api.sql`): statement-level `AFTER INSERT OR UPDATE OR DELETE … REFERENCING NEW TABLE / OLD TABLE` triggers on `farm.jobs`, `farm.job_assignments` and `farm.job_products`, **one `app.publish('jobs', 'updated', …)` per statement**, delivered on commit | the board refetches its snapshot (or the named jobs); the field panel's Jobs tab and its open-jobs count refetch when `fieldIds` has their field |
| `jobs` / `invalidate` | `InvalidatePayload` `{ event: 'updated', reason: 'too_large' }` when the payload text would pass `JOBS_TRIGGER_MAX_PAYLOAD_BYTES` (7,000; the trigger measures `octet_length` of the jsonb text), `{ event: 'updated', reason: 'changed' }` once after a `data:import` | the trigger; `data:import` | refetch everything (onResync) |

Rules for the triggers (jobs-api):

- **No TypeScript code publishes `jobs`** (no double publish). Job writes never publish `fleet`
  or `fields` (no `fields`/`updated` for a job: the panel subscribes to `jobs`; never touch
  `fleet`'s `app.topic_seq` row from a job write).
- One message per statement, never per row: a bulk insert of 500 jobs gives **one**
  `invalidate` (too large), not 500 messages. A statement that changes no row publishes nothing.
- Quiet when `current_setting('app.jobs_publish', true) = 'off'` (data:import's transaction).
- The functions are `create or replace`, `security invoker` (they call `app.publish`, which is
  SECURITY DEFINER), live in schema `app` (`app.publish_jobs_*`), and the triggers are created
  idempotently (`drop trigger if exists` + `create trigger`).
- DB tests (plan §7): a write → a test LISTEN on `app_events` receives `jobs`/`updated` within
  1 s with `seq` incrementing; old and new field ids; a rolled-back write sends nothing; 500
  jobs in one statement → one invalidate; the import GUC silences them.

`TOPICS` lists `jobs`; `types.test.ts` checks it. **MD:** the `realtime.messages` RLS policies
must cover `jobs` (noted in `docs/status.md`).

---

## 7. UI layout and seams

### 7.1 The board (board builder; brief "Board UI")

- **Wall:** the jobs band is a **row of its own** between the status strip and the map area
  (`.screen` is a flex column, so the map area shrinks; no panel is covered; `fit.ts` needs no
  change). Proposed default height **208 px** (`--jobs-band`): the map area keeps 800 of 1080 px
  (74 %; the floor is 65 %, a band of at most 306 px). The foundation's stub renders **nothing**
  on the wall (see "Measured" below), so today's wall is exactly 1f's. Lanes side by side; cards scroll horizontally within a lane or the
  band scrolls (set `touch-action` per scroller, as the fleet panel's `.scroll` uses `pan-y`);
  a "New job" button (managers); the **chips tray** at the band's right end: person chips (crew,
  `GET /api/v1/crew`) and machine chips (non-retired machines from `useFleetPanel()`). The band
  can collapse to a thin bar (remembered per device in `localStorage`). Touch targets 72 px.
  The rail, the fleet panel, the weather strip and the map controls stay visible by default.
  **Measured (the foundation ran the full e2e suite with an empty 208 px band, Nov 6):** 162
  passed, and three wall specs failed because of the band; the board builder lands the band
  with them green (a shorter default, or the specs' tap helpers revealing the point inside the
  free map area, as `revealAbovePanel` does on phones; say which in the report):
  - `e2e/board.spec.ts` "map controls": the shorter map area lowers the first fit of the 40 demo
    fields below z10, so the rail shows "Zoom in to see it (from zoom 10)" under Deere flags,
    and that hint is a button too. **Fixed** in the foundation: the spec matches the controls
    with `exact: true` (do the same in any test that finds a button by such a name).
  - `e2e/deere-fields.spec.ts` "a flag tap closes an open field panel; a tap on open ground
    closes the popup" and `e2e/imagery.spec.ts` "tile lines: a manager draws a tile line …":
    their taps near the map centre (after `jumpTo` a point) land on the weather strip, which
    stays anchored to the screen's bottom while the map centre moves 104 px down (the free map
    area becomes y 280-790 instead of 72-790).
  (The fourth failure of that run, `e2e/m0-demo.spec.ts` "trucks API down", failed the same way
  on `main` against this dev database while the CNH combine C3's position was days old, and
  passed once the CNH stand-in's backlog had caught up.) With the stub rendering nothing, the
  required specs plus `deere-fields` and `imagery` passed: 60 passed, 14 skipped.
- **Phone:** a **"Jobs" pill**, third in the top-left stack (left 12, top 112; Fleet at 12,
  weather at 62), opens a **bottom sheet** reusing `src/ui/fields/sheet.ts` snaps; **closed by
  default** (`revealAboveSheet` / `revealAbovePanel` in existing specs know only the field
  panel and the pin popup). The sheet pins its chips tray at the top; when a drag starts the
  sheet drops to **peek** so the map is reachable while the tray stays visible. One sheet at a
  time (§7.2). Touch targets 48-52 px.
- **Cards:** the status colour (`JOB_STATUS_COLORS`, §7.4), the kind (`JOB_KIND_GLYPHS` or its
  label), field name, acres, window, products summary, assignment chips (machine unit + person,
  × for managers), the flags. Tap a card: the job detail (wall: a popover near the band; phone:
  the sheet's detail view) with edit (job-forms' `JobForm`), the status buttons
  (`nextJobStatuses`), cancel.
- **Drag (dnd-kit 6.3.1):** sensors `MouseSensor` (distance 6 px), `TouchSensor` (delay 200 ms,
  tolerance 8 px) and `KeyboardSensor`; collision `pointerWithin` with **chips before the map
  droppable**; while a drag runs `map.dragPan.disable()` and `map.touchZoomRotate.disable()`,
  re-enabled on end and cancel; a hover highlight on the field under the pointer
  (`DROP_HOVER_LAYER_IDS`: `work-drop-hover-fill` / `-line`, the pattern of
  `src/ui/fields/highlight.ts`; never the field panel's layers); a `DragOverlay` above
  everything (`DRAG_OVERLAY_Z_INDEX = 50`, pointer-events none). Map gestures keep working
  outside a drag (MapLibre accepts untrusted touches; don't filter on `isTrusted`).
- **Data:** snapshot `GET /api/v1/jobs` after the realtime `ready`; subscribe `jobs` through
  `resolveRealtimeClient` (`src/ui/map/fleet/realtime.ts`; the e2e double works); refetch on
  `updated` (all, or the named jobs) and in `onResync`; never two requests at once (a trigger
  during a request queues one more); poll every 15 s while `connected()` is false
  (`src/ui/fields/detail-loader.ts` is the pattern).

### 7.2 Seams in BoardScreen (already in place; integrator-owned)

```tsx
<StatusStrip …/>
<WorkBoardProvider variant={variant} map={map}>                 // src/ui/work/board/WorkBoardProvider.tsx
  {variant === 'wall' && <WorkBoard variant="wall" map={map} config={data.config} onOpen={onWorkOpen} />}
  <div className={mapArea}>
    …WarRoomMap, rail, fleet panel, weather, cards, tile tool, pins, field panel, soil sheet…
    {variant === 'phone' && <WorkBoard variant="phone" map={map} config={data.config} onOpen={onWorkOpen} />}
  </div>
</WorkBoardProvider>
<PhoneMachineCard …/>
<UsageHeartbeat route={variant === 'wall' ? '/board' : '/m'} />  // src/ui/usage/UsageHeartbeat.tsx
```

- `WorkBoardProviderProps { variant, map: maplibregl.Map | null, children }` (stub: renders the
  children). `WorkBoardProps { variant, map, config: PublicConfig, onOpen?() }` (stub: nothing on
  the wall, an inert pill on phones). Frozen, additive only.
- **One sheet at a time:** `useWorkBoardUi` (`src/ui/work/board/store.ts`: `overlayOpen`,
  `setOverlayOpen`) and `closeWorkBoardOverlays()`. BoardScreen calls `closeWorkBoardOverlays()`
  when a field opens (`onFieldTap`), a machine is picked (`onSelect`) and in `closePanels` (the
  pin popup and the tile tool use it); the board calls `onOpen()` when it opens its phone sheet or
  its wall popover, and BoardScreen closes the field panel and the soil sheet (and, on phones,
  the machine card). Drops never call `onFieldTap`.
- **z-order:** wall band = a flex row (no z-index needed); job popover over the band and the map
  area's top, under the status sheet (z 40); phone pill z 2 (with the other top-left buttons);
  jobs sheet **z 22** (above the field sheet 20, the weather sheet 20 and the soil sheet 21,
  under the fleet sheet 25: one is open at a time anyway); drag overlay z 50.
- **Map access:** the board gets the same MapLibre map as the rail (`onMapReady`); it may add its
  own layers (hover highlight, ids above) and must remove them on unmount; it never changes
  WarRoomMap's props. Dropping on a deck.gl machine marker is not in 2a (chips only).

### 7.3 Forms and the Jobs tab (job-forms)

- `JobFormProps { variant, job?: JobView | null, initial?: { fieldId?, kind?, businessLine? },
  onSaved(job: JobView), onCancel() }` (`src/ui/work/forms/JobForm.tsx`; frozen). Rendered by the
  board (new / edit) and by the Jobs tab ("New job here", `initial.fieldId`, inline in the tab).
  It loads `GET /api/v1/job-options`, saves with POST (new) or PATCH (edit, with the version; a
  409 shows `JOB_CONFLICT_MESSAGE` and the current job), and offers the request channel and
  requester for a `requested` job (decision 2a-9).
- The Jobs tab (`jobsTab`, id `jobs`, `TAB_ORDER.jobs = 15`): the field's open jobs with status
  colour (`GET /api/v1/jobs?fieldId=`; refetch on `jobs`/`updated` with this field in
  `fieldIds` and in onResync; the tab gets no config: take the realtime mode the way the History
  tab does, from its own response or `resolveRealtimeClient`), "New job here" for managers.

### 7.4 The status palette (`src/ui/work/style.ts`, contract)

`JOB_STATUS_COLORS` (fill + text per status), `statusLook(status)`, `JOB_KIND_GLYPHS`,
`kindLabel`, `laneLabel`, `DRAG_OVERLAY_Z_INDEX`, `DROP_HOVER_LAYER_IDS`. Cards, the Jobs tab
and any legend use only these.

### 7.5 Test ids (every spec uses these)

| Where | `data-testid` (and data attributes) |
|---|---|
| Wall band | `jobs-band` (`data-variant="wall"`, `data-collapsed`), its lanes `jobs-lane` (`data-business-line`), `jobs-band-toggle`, `job-new` |
| Phone | `jobs-pill`, `jobs-sheet` (`data-snap` peek / half / full), `jobs-sheet-handle` |
| Cards | `job-card` (`data-job-id`, `data-status`, `data-business-line`, `data-field-id` or empty, `data-version`), on a card `job-assignment-chip` (`data-assignment-id`, `data-machine-id`, `data-party-id`) with `job-assignment-remove`, `job-flag` (`data-flag`) |
| Chips tray | `jobs-chips-tray`, `chip-machine` (`data-machine-id`, `data-unit`, `data-status`, `data-work-plan`), `chip-person` (`data-party-id`) |
| Drag | `job-drag-overlay`, the map drop zone `jobs-map-drop` |
| Job detail | `job-detail` (`data-job-id`), `job-status-<status>` buttons, `job-edit`, `job-cancel`, `job-conflict` (the 409 message) |
| Form | `job-form` (`data-mode` new / edit), `job-form-save`, `job-form-cancel`, fields `job-form-<name>` |
| Field panel | `field-tab-jobs`, `field-jobs` (the list), `field-job-row` (`data-job-id`, `data-status`), `field-new-job` |
| Admin | `products-table`, `product-row` (`data-product-id`), `product-new`; `usage-report`, `usage-day` (`data-farm-day`, `data-gate` pass / fail / skip), `usage-gate`; `party-agreements`, `agreement-row`; `party-request-links`, `request-link-row`; `deere-org-rights` (`data-org`, `data-state` agreed / blocked / reported / home) |
| `/r/<token>` | `request-form`, `request-submit`, `request-done`, `request-refused` |

### 7.6 Admin pages

`/admin/products` (job-forms; nav "Products") and `/admin/usage` (rights-usage; nav "Usage"):
stub pages in place (`requireRole(ROLE_FOR.admin)`, the `NoAccess` refusal). `/admin/usage`:
the last `USAGE_REPORT_DAYS` farm days, each with the daily active crew (distinct signed-in
people of `CREW_APP_ROLES`, excluding the owner and source demo and e2e people; names listed),
board time per device (heartbeat buckets × 5 min), job actions, morning-mode runs ("starts in
2b"); the gate line "crew used the board every day" passes for a day with at least
`PHASE2_MIN_DAILY_CREW` active crew, Sundays not counted. The agreements and request-link
sections on `/admin/parties/<id>` (§1.2).

### 7.7 The usage writer (`src/platform/usage/record.ts`, rights-usage)

```ts
interface UsageInput { kind: UsageKind; route: string; appUserId: string | null; deviceId: string | null }
usageOf(session: Session, kind, route): UsageInput
recordUsage(input: UsageInput, opts?: { ex?: Executor; now?: Date }): Promise<void>   // never throws
```

Called (already) from the `/board` and `/m` page renders (`page_view`) and `signInOperator`
(`pin_sign_in`, route = the device's home); jobs-api calls it per job write (`job_action`, the
route pattern as `route`); `POST /api/v1/usage` (`board_heartbeat`) from `UsageHeartbeat` every
`USAGE_HEARTBEAT_MS` while the page is visible and has a session; 2b adds `morning_run`. Never
from `proxy.ts`. The row: `farm_day = farmDate(at)`, `actor_key = usageActorKey(…)`,
`bucket_at = usageBucketStart(at)`, `on conflict (actor_key, kind, route, bucket_at) do
nothing`. Retention: `usage.prune` (daily) deletes rows older than `USAGE_RETENTION_DAYS`.

---

## 8. E2E helpers (`e2e/support/drag.ts`, integrator-owned)

- `touchDrag(page, from, to, { holdMs = 350, steps = 12, stepMs = 16, settleMs = 150, cdp? })`:
  a **trusted** one-finger drag through `Input.dispatchTouchEvent` (press, hold still for the
  TouchSensor's 200 ms, move in steps, rest, lift). Chromium only.
- `mouseDrag(page, from, to, { steps, stepMs, settleMs, nudgePx = 10 })`: press, a nudge past
  the MouseSensor's 6 px, move, rest, release.
- `dragTo(page, sourceLocator, targetLocator | point, { pointer: 'touch' | 'mouse', … })`,
  `centerOf(locator)`, `mapPoint(page, { lng, lat })` (`window.__map.project`, viewport px).
- Self-test: `e2e/drag-helpers.spec.ts` (blank page: event order, `isTrusted`, the hold).
- Two contexts (the done-when): `browser.newContext(contextOptions())` twice (the pattern of
  `e2e/field-panel.spec.ts` and `e2e/fleet-panel.spec.ts`), `signInAs(drager, 'manager')`,
  `signInAs(watcher, 'viewer')`; the spec runs on the `wall` project only
  (`test.skip(info.project.name !== 'wall')`) and drives a wall context (1920 × 1080, DPR 2,
  touch) and a phone context (Pixel 7) itself; timing as `fleet-panel.spec.ts` (start the clock
  at the drop's touchEnd, stop when the other screen shows it; log `took`; assert `< 2000`).
  Seed e2e jobs (source `e2e`) on an e2e field in an empty corner of the map (as
  `field-panel.spec.ts` does), remove them after; don't move the demo jobs.
- Map points: jump the map with `window.__map.jumpTo` (z15) and drop at `mapPoint` of the
  field's centre after `queryRenderedFeatures` shows it, as `field-panel.spec.ts` `openAt` does.

---

## 9. The demo seed (`tools/seed/work.ts`, integrator-owned, already done)

`pnpm db:seed demo` (and so `db:reset` and bootstrap) writes, after the demo farm and people:
**8 products** (`DEMO_PRODUCTS`: glyphosate, 2,4-D and a restricted-use atrazine with
placeholder EPA numbers `DEMO-000n`, a fungicide, seed corn, soybean seed, 28% UAN, off-road
diesel), **10 jobs** (`DEMO_JOBS`: spraying 4, grain 3, trucking 2, store 1; statuses
requested, planned, assigned, in_progress and done) with assignments and products, and the
**Halvorsen agreement** (all four uses; none for Juniper Hill). The done-when's pieces: an
**unassigned planned spray job on a Halvorsen field** (`job-spray-halvorsen-burndown`) and a
**requested spray job with no field** that Juniper Hill phoned in (`job-spray-juniper-request`,
requester Gail Pressler); **SP2 is on no job**. All `source = 'demo'`, ids `demoId(key)`;
windows from the farm day of the first run; jobs written once (what the demo did on the board
stays until `db:reset`); products and the agreement only change when a seeded value does
(`active`, `label_rules` and `revoked_on` are yours). Tested in `tools/seed/work.db.test.ts`.

---

## 10. Decisions (defaults in force; easy to change; rows 2a-1 … 2a-13 in `docs/decisions.md`)

| # | Default | Where it lives |
|---|---|---|
| 2a-1 Crews = business lines | one lane per business line (Spraying, Grain, Trucking, Store), each ordered by priority, window start, sort key; no crews table; each card shows who and what is on it | `BUSINESS_LINES`; the snapshot query |
| 2a-2 Who may do what | create, edit, assign, reorder, cancel: manager (`ROLE_FOR.planJobs`); own job assigned/pushed → in progress → done: driver and up (`updateOwnJobStatus`); managers any status; seeing jobs: viewer. The wall alone is a viewer: a drag there needs a manager's PIN (demo: Amy Kovach) | `src/platform/auth/types.ts`; `checkJobTransition` |
| 2a-3 Status machine | §4.3 | `src/domain/work-jobs.ts` |
| 2a-4 Drag semantics | §4.5 | the board; `PUT …/field`, `POST …/assignments` |
| 2a-5 Planned acres | the field's current boundary acres when the field is set, unless typed; later boundary changes don't move them; both shown when they differ > 1 %; billing acres stay D16's | `ACRES_DIFFER_FRACTION`; jobs-api's queries |
| 2a-6 Crop year on jobs | set with the field from its growing year (D23), else the calendar year; the other synced season can be picked; no second date rule | `farm.jobs.crop_year`; `fieldGrowingYear` |
| 2a-7 Optimistic concurrency | `version` compare-and-set on the job row for every job or child write; 409 with the current job; "Changed on another screen; try again" | §4.7 |
| 2a-8 Realtime by trigger | statement-level triggers, ids only, one message per statement, `invalidate` over 7,000 bytes, no TypeScript publish, never `fleet` or `fields` | §6 |
| 2a-9 Requests by text or phone | a manager types a `requested` job with the channel and who asked; the stretch per-customer revocable link `/r/<token>` (128-bit token stored as an HMAC, 20 requests a link a day), LAN-only until MD | §5.5 |
| 2a-10 Data-rights gate (D17) | enforced in sandbox and live in every Deere per-org loop through one predicate; reported in sim and replay; an org can be linked to a customer before its first sync; prospecting a pure policy; CNH not gated; demo: Halvorsen signed, Juniper Hill not | §4.4 |
| 2a-11 Usage events and the gate report | §3.1, §7.6, §7.7; `PHASE2_MIN_DAILY_CREW = 2`, Sundays skipped, 400 days kept, exported by data:export | `src/domain/work-jobs.ts` |
| 2a-12 Products | §3.1; `/admin/products`; job products edited in the job form; 8 demo products | job-forms |
| 2a-13 2b preparation | `jobs.deere_work_plan_id`; the machine chip's "Deere" badge from `workPlanCapable`; no outbox, no push | §5.6 |

**Foundation choices beyond the brief** (also defaults, easy to change):

- `farm.jobs.window` is named **`planned_window`** (WINDOW is reserved in SQL; every raw query
  would need quotes).
- `farm.jobs.status_changed_at` (the board keeps a job done today in its lane; 2b's morning
  mode reads yesterday's moves) and `farm.jobs.request_link_id` (counting a link's requests per
  day without a second table).
- `farm.job_assignments.planned_for` is a `tstzrange` (null = the job's window); one row per
  person and one per machine on a job (partial unique indexes).
- `app.usage_events.actor_key` + `bucket_at` with a unique key instead of a `nulls not
  distinct` key over the nullable ids: deleting a person or device (set null) never collides.
- `priority` is 1 urgent … 4 low, default 3; `sort_key` a double.
- Planned units add **tons** and **gal** to the plan's loads, bu, hours (the store lane's
  deliveries); rate units are per acre (`*_ac`) or totals.
- The Jobs tab sits at `TAB_ORDER.jobs = 15`, right after Overview, hidden until job-forms lands.
- The wall's stub renders nothing (an empty 208 px band broke two wall specs' taps, §7.1); the
  phone's stub is an inert "Jobs" pill in its final place. `e2e/board.spec.ts` matches the map
  controls with `exact: true` (the band's lower first zoom shows a "Zoom in to see it" hint).
- `PanelMachine.workPlanCapable` from the Deere sync's source or a Deere machine ref.
- `usage.prune` is a daily job (07:23 UTC) with a stub run.
- Demo EPA numbers are placeholders (`DEMO-0001` …), never a real registration.

---

## 11. Done when

Every builder: §2 "Quality" green in its worktree, the report written. Then, per builder:

### 11.1 jobs-api

- Every route of §5.2 (except `/api/v1/job-options` and `/api/v1/usage`) answers as specified:
  handler DB tests over `ROLES` for every route (401 signed out, 403 below the role, 400 / 404 /
  409 / 413 / 415 / 422 cases, cross-site refused), the 409 carrying the current job.
- The status machine and `autoJobStatus` unit-tested exhaustively (§4.3); `jobSummary`;
  conflict flags (`double_booked` with overlapping windows only, `machine_down`, `no_field`,
  `acres_differ` at 1 %, `restricted_use`).
- Drag semantics (§4.5) as DB tests: field by id and by point (inside a current boundary,
  outside = 422, a hidden-layer case), customer default from the farm's client, acres snapshot
  and by-hand, crop year from `fieldGrowingYear`; machine then person fills one row; person then
  machine fills one row; a second machine makes a second row; already on = no-op; a down machine
  accepted and flagged; unassign whole and by part; the automatic moves both ways.
- Concurrency: two writers with the same version, one wins, the other 409, in parallel
  (`Promise.all`), for the job row, an assignment and reorder.
- The triggers in `db/pending/jobs-api.sql` with the DB tests of §6 (within 1 s, seq up, old and
  new field ids, rollback silent, 500-row statement = one invalidate, the import GUC).
- `GET /api/v1/crew`; `job_action` usage through `recordUsage`; the field detail's real
  open-jobs count (assigned lines, §1.2) refetched on `jobs`; `deleteParty` explains each new
  link.

### 11.2 board

- The wall band and phone pill/sheet as §7.1, the test ids of §7.5, the chips tray from crew and
  `useFleetPanel()`, collapse remembered, the "Deere" badge, job detail with status buttons and
  edit (`JobForm`), cancel, × on assignment chips, the 409 message.
- **`e2e/m2a-board.spec.ts` (the done-when):** under `next start`, two contexts, the `wall`
  project, trusted touch through CDP (`e2e/support/drag.ts`): (1) the wall (manager) drags the
  requested spray job onto a field, then onto SP2, then onto an operator; the phone (viewer)
  shows the card on that field with "SP2 · <operator>" each time within 2 s (`took` logged and
  `< 2000`); (2) the phone (manager) drags a job (field, machine, person) and the wall (viewer)
  shows it within 2 s. Before the merge it runs with route mocks for the API and the e2e realtime
  double for the second screen; the integrator runs it unmocked.
- E2E for the layouts: the band at its default height leaves every M0/M1/1f wall spec green and
  the map area ≥ 65 % of the screen; the phone sheet closed by default, peek on drag start, one
  sheet at a time; a drag never pans the map, a pan never drags a card; a drop on empty map or
  outside changes nothing; a viewer sees no drag handles and no "New job".

### 11.3 job-forms

- The form creates and edits every field of a job (§7.3) against the contract (mocked until the
  merge), the requested-by-text/phone path, the products editor with units and supplied-by, the
  409 path; `GET /api/v1/job-options` with DB tests.
- The Jobs tab lists the field's open jobs with the status colour, refetches on `jobs` for that
  field, "New job here" for managers (hidden for viewers), with e2e.
- `/admin/products`: list, add, edit, retire (a product on a job can't be deleted: retire it),
  manager-only (403 page for a driver), with DB tests for the queries.
- Request links: make (token shown once), revoke, `last_used_at`; `/r/<token>` GET form, POST
  creates a requested job, a revoked or unknown token refused, the 21st request of a farm day
  refused; e2e without a session.

### 11.4 rights-usage

- `orgReadAllowed` / `loadOrgReadRights` real (§4.4) with unit and DB tests, each Deere loop
  tested in sandbox mode against the stand-in with a refused customer org; sim and replay
  unchanged (`e2e/deere-fields.spec.ts`, `m1f-replay`, the job-orgs DB tests green).
- `/admin/connectors`: each customer org "agreement on file" or "no agreement: blocked in live",
  "link to customer" for an org with no party; `/admin/parties/<id>`: agreements listed,
  recorded with an uploaded document (two-step grant), revoked; `mayUseCustomerData` tested.
- Usage: `recordUsage` real (never throws, the bucket dedupe), `POST /api/v1/usage` and
  `UsageHeartbeat`, `/admin/usage` with the gate line (unit tests for the day math: DST,
  Sundays, owner/demo/e2e excluded), `usage.prune` with a DB test (400 days, batches).

### 11.5 The slice (integrator, after merging)

- All four branches merged into `claude/m2-2a`, the stubs gone, `db/pending/jobs-api.sql` folded
  into migration **`0009_m2a_triggers`** (or the next free number; 1e takes the one after),
  mirrored, applied to `postgres` and the template; `pnpm exec drizzle-kit generate` says "No
  schema changes"; `pnpm db:lint` (migrations from zero, twice) green.
- `pnpm lint`, `typecheck`, `test`, `test:db`, `build` and the **full** e2e suite green, the M0,
  M1 and 1f demo specs included; **`e2e/m2a-board.spec.ts` unmocked under `next start` in both
  directions** with `took < 2000` logged; the replay step (`CONNECTOR_DEERE=replay`,
  `CONNECTOR_SAMSARA=replay`: `m1f-replay` and the replay specs) green with the gate in place.
- By hand under `pnpm pilot`: the wall with Amy's PIN and a phone, the done-when on the demo's
  requested spray job (a field, SP2, Dale), the other screen within 2 s; a viewer can't drag;
  `/admin/usage` shows the day; `/admin/connectors` shows Halvorsen agreed and Juniper Hill
  reported.
- The assigned M1 spec line (`e2e/field-panel.spec.ts` open jobs), `docs/build-plan.md` 2a boxes
  ticked with an as-built note, `docs/decisions.md` rows current, `docs/status.md` entry, README
  (the job board, request links LAN-only, the usage report).

---

## 12. For Derrick's PC (not buildable here)

- Slice 1e's `db/pending/pc-1e.sql` takes **the next free migration number after 0008** when it
  merges (0008 went to 2a; the triggers will likely take 0009, so 1e then takes 0010 or later).
- After pulling: `pnpm db:migrate` (0008) and `pnpm db:seed demo` once (the demo products, jobs
  and the Halvorsen agreement).
- D17's agreement wording is due Mar 1, 2027 (an attorney's): until then the gate treats any
  signed agreement on file as enough.
