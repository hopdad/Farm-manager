/**
 * Builds deere-ops's doc-derived replay fixture (docs/contracts-1f.md §8, numbers 30-39):
 * `operations/30-field-operations-2026.json`, this crop season's field operations on every demo
 * field the 1a operations fixture doesn't already answer, so `CONNECTOR_DEERE=replay` lists
 * operations for every field the replayed fields listing names instead of 404s:
 *
 *  - the first OPS_FIXTURE_FIELDS home fields: their spring planting (a seeding with its variety
 *    and the seeding rate), with `embed=measurementTypes` already in the listing (the 1a
 *    operations exercise the per-operation measurementTypes call instead), and its coverage
 *    (the field boundary); the other fields list no operations (the file stays small);
 *  - one soybean field also has a burndown application (a tank mix with carrier and
 *    components), so products show in replay;
 *  - one field answers 400 for its coverage, as Deere does for a field with an active boundary,
 *    so the "measured area, no coverage" path runs in replay too;
 *  - customer-org fields and a sharing org's copies list no operations.
 *
 * SHAPES: Deere's Field Operations and Boundaries APIs (field-operations__field-operation.yaml,
 * field-operations__measurement-type.yaml, boundaries; see ./schemas.ts), made by the SAME
 * functions the stand-in serves them with (src/sim/vendors/deere/ops-routes.ts), so sim and
 * replay agree. VALUES: the simulated demo farm (seed 1, harvest-day, wall clock at the 1a
 * operations anchor), no real farm data; every vendor id is one the demo seed maps.
 *
 * The committed JSON is this module's output; ./fixtures.test.ts fails when they drift.
 * Regenerate with   pnpm exec tsx src/connectors/deere/ops/fixtures-write.ts   then
 * `pnpm lint:fix`.
 */
import { createSimWorld } from '../../../sim/index';
import { simCoverageReply, simOperationJson } from '../../../sim/vendors/deere/ops-routes';
import {
  type SimOperation,
  type SimOpsContext,
  simOperations,
} from '../../../sim/vendors/deere/ops-world';
import { simDeereFields } from '../../../sim/vendors/deere/platform';
import type { DemoWorld } from '../../../sim/world';
import type { ReplayExchange, ReplayFixture } from '../../replay';
import { OPERATIONS_ANCHOR } from '../fixtures/build';
import { deereDocDerived1aFixtures } from '../replay';

/** The real API root the fixture's links name (the replay transport never contacts it). */
const API = 'https://sandboxapi.deere.com/platform';
const SEED = 1;
/** Home fields given this season's operations (the rest list none). */
export const OPS_FIXTURE_FIELDS = 10;

export const OPS_FIXTURE_FILE = 'operations/30-field-operations-2026.json';

const REFERENCE =
  'https://developer.deere.com/dev-docs/field-operations (GET /organizations/{orgId}/fields/{fieldId}/fieldOperations?cropSeason&embed=measurementTypes, FieldOperation with varieties, products and fieldOperationMachines, FieldOperationMeasurement; scope ag2); https://developer.deere.com/dev-docs/boundaries (GET /fieldOperations/{operationId}/boundary: the worked area, 400 when the field has an active boundary). Values: the simulated demo farm (src/sim, seed 1, harvest-day), no real farm data.';

const enc = encodeURIComponent;
const fieldPath = (org: string, fieldId: string) =>
  `/organizations/${enc(org)}/fields/${enc(fieldId)}`;

/** Listing paths the 1a operations fixture already answers (they must not be shadowed). */
function answeredBy1a(): Set<string> {
  const out = new Set<string>();
  for (const f of deereDocDerived1aFixtures) {
    for (const x of f.exchanges) {
      if (x.request.path.endsWith('/fieldOperations')) out.add(x.request.path);
    }
  }
  return out;
}

function get(path: string, status: number, body: unknown): ReplayExchange {
  return { request: { method: 'GET', path }, response: { status, body } };
}

/** Deere's platform error body (machine-alerts spec `ErrorResponseBody`). */
const deereError = (status: number, message: string) => ({
  '@type': 'Errors',
  errors: [{ '@type': 'Error', code: String(status), message }],
});

export function buildDeereOpsFixtures(): Record<string, ReplayFixture> {
  const world = createSimWorld({ scenario: 'harvest-day', seed: SEED }) as DemoWorld;
  const now = new Date(OPERATIONS_ANCHOR);
  const c: SimOpsContext = {
    world,
    days: null, // the season's planting only: the 1a fixture holds the harvest day
    now,
    simNow: world.startsAt,
    clock: {
      anchorWall: now.toISOString(),
      anchorSim: world.startsAt.toISOString(),
      speed: 1,
      paused: false,
    },
    knobs: {},
  };
  const skip = answeredBy1a();
  const listed = simDeereFields(world.farm).filter(
    (f) => !skip.has(`${fieldPath(f.orgId, f.deereFieldId)}/fieldOperations`),
  );
  const all = simOperations(c);
  const home = listed
    .filter((f) => f.orgId === 'org-home' && !f.shared)
    .slice(0, OPS_FIXTURE_FIELDS);
  const withOps = new Set(home.map((f) => f.field.id));
  // One field refuses coverage; one soybean field also got a burndown.
  const refusedField = home[5]?.field.id;
  const sprayField = home.find(
    (f, i) => i !== 5 && all.some((o) => o.field.id === f.field.id && o.crop === 'soybeans'),
  )?.field.id;

  const exchanges: ReplayExchange[] = [];
  for (const f of listed) {
    const path = `${fieldPath(f.orgId, f.deereFieldId)}/fieldOperations`;
    const ops: SimOperation[] = all
      .filter((o) => o.orgId === f.orgId && o.deereFieldId === f.deereFieldId)
      .filter((o) => withOps.has(o.field.id))
      .map((o) => ({ ...o, coverageRefused: o.field.id === refusedField }));
    const planting = ops[0];
    if (planting && f.field.id === sprayField) {
      const start = Date.parse(planting.startDate) - 2 * 86_400_000;
      ops.unshift({
        ...planting,
        id: `${planting.id}-burndown`,
        kind: 'application',
        startDate: new Date(start).toISOString(),
        endDate: new Date(start + 95 * 60_000).toISOString(),
        modifiedTime: new Date(start + 95 * 60_000).toISOString(),
        machines: world.farm.machines.filter((m) => m.key === 'sprayer-1'),
        operatorsByMachine: Object.fromEntries(
          world.farm.machines
            .filter((m) => m.key === 'sprayer-1')
            .map((m) => [m.id, ['Luis Ortega']]),
        ),
      });
    }
    const values = ops.map((o) => simOperationJson(c, o, API, true));
    exchanges.push(
      get(path, 200, {
        links: [{ rel: 'self', uri: `${API}${path}` }],
        total: values.length,
        values,
      }),
    );
    for (const o of ops) {
      const bPath = `/fieldOperations/${enc(o.id)}/boundary`;
      if (o.coverageRefused) {
        exchanges.push(
          get(
            bPath,
            400,
            deereError(
              400,
              'A boundary cannot be generated for this field operation: the field already has an active boundary',
            ),
          ),
        );
        continue;
      }
      const reply = simCoverageReply(o, API);
      if (reply.kind !== 'reply' || !reply.body) throw new Error('coverage reply expected');
      exchanges.push(get(bPath, reply.status, JSON.parse(reply.body)));
    }
  }
  const fixture: ReplayFixture = {
    format: 1,
    source: 'deere',
    stream: 'operations',
    kind: 'doc-derived',
    reference: REFERENCE,
    anchor: OPERATIONS_ANCHOR,
    basePath: '/platform',
    exchanges,
  };
  return { [OPS_FIXTURE_FILE]: fixture };
}
