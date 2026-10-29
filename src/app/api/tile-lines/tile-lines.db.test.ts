/**
 * /api/tile-lines against a real database (as farm_app), through the route logic with
 * runWithSession: roles (viewer reads, manager+ writes, signed-out 401), validation, the field
 * found from the line, optimistic versions, reshaping, Deere lines read-only, deletes, the
 * private tile_lines MVT, and `layers`/`updated` published with every write.
 */
import { describe, expect, test } from 'vitest';
import { decodeMvt } from '../../../../tools/gis/mvt';
import type { TileLineView } from '../../../db/queries/tile-lines-schema';
import { makeSession, runWithSession } from '../../../platform/auth/testing';
import type { Role } from '../../../platform/auth/types';
import { setupTestDb } from '../../../test/db';
import { insertField, squareMultiPolygon, tileFor } from '../../../test/fixtures';
import {
  handleCreateTileLine,
  handleDeleteTileLine,
  handleListTileLines,
  handleUpdateTileLine,
} from './handler';

const t = setupTestDb(import.meta.url);

const as = <T>(role: Role | null, fn: () => Promise<T>) =>
  runWithSession(role ? makeSession({ role }) : null, fn);

const req = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function layersSeq(): Promise<number> {
  const r = await t().pool.query<{ seq: string }>(
    `select seq from app.topic_seq where topic = 'layers'`,
  );
  return Number(r.rows[0]?.seq ?? 0);
}

// Two fields side by side, 400 m squares.
const WEST = squareMultiPolygon(-84.06, 41.89, 400);
const EAST = squareMultiPolygon(-84.054, 41.89, 400);
const inWest = {
  type: 'LineString',
  coordinates: [
    [-84.0595, 41.8905],
    [-84.0595, 41.8925],
  ],
};
const inEast = {
  type: 'LineString',
  coordinates: [
    [-84.0535, 41.8905],
    [-84.0535, 41.8925],
  ],
};
const BBOX = '-84.07,41.88,-84.04,41.90';

let westId = '';
let eastId = '';

describe('/api/tile-lines', () => {
  test('setup: two fields', async () => {
    westId = (await insertField(t().db, { name: 'West 40', geom: WEST })).fieldId;
    eastId = (await insertField(t().db, { name: 'East 40', geom: EAST })).fieldId;
  });

  test('reads: viewers may read (canEdit false); managers get canEdit; signed out 401; bad queries 400', async () => {
    const viewer = await as('viewer', () =>
      handleListTileLines(req('GET', `/api/tile-lines?bbox=${BBOX}`), t().pool),
    );
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get('cache-control')).toBe('no-store');
    expect(await json(viewer)).toEqual({ lines: [], canEdit: false, truncated: false });
    const manager = await as('manager', () =>
      handleListTileLines(req('GET', `/api/tile-lines?bbox=${BBOX}`), t().pool),
    );
    expect((await json(manager)).canEdit).toBe(true);
    expect(
      (
        await as(null, () =>
          handleListTileLines(req('GET', `/api/tile-lines?bbox=${BBOX}`), t().pool),
        )
      ).status,
    ).toBe(401);
    for (const q of ['', '?bbox=1,2,3', '?bbox=-100,30,-80,50', '?fieldId=nope']) {
      expect(
        (await as('viewer', () => handleListTileLines(req('GET', `/api/tile-lines${q}`), t().pool)))
          .status,
        q,
      ).toBe(400);
    }
  });

  test('writes need manager+: 401 signed out, 403 below manager, nothing stored', async () => {
    const body = { geometry: inWest, kind: 'main' };
    expect(
      (await as(null, () => handleCreateTileLine(req('POST', '/api/tile-lines', body), t().pool)))
        .status,
    ).toBe(401);
    for (const role of ['viewer', 'driver', 'operator'] as const) {
      const res = await as(role, () =>
        handleCreateTileLine(req('POST', '/api/tile-lines', body), t().pool),
      );
      expect(res.status, role).toBe(403);
    }
    // A manager's browser on another site's page (another port of the PC counts): refused.
    const crossSite = new Request('http://192.168.1.20:3000/api/tile-lines', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: '192.168.1.20:3000',
        origin: 'http://192.168.1.20:8080',
      },
      body: JSON.stringify(body),
    });
    const refused = await as('manager', () => handleCreateTileLine(crossSite, t().pool));
    expect(refused.status).toBe(403);
    const n = await t().pool.query('select count(*)::int as n from farm.tile_lines');
    expect(n.rows[0]?.n).toBe(0);
  });

  test('a manager draws a line: 201, its field found from the shape, published, in the private tiles', async () => {
    const before = await layersSeq();
    const res = await as('manager', () =>
      handleCreateTileLine(
        req('POST', '/api/tile-lines', {
          geometry: inWest,
          kind: 'main',
          sizeIn: 6,
          depthFt: 3.5,
          installedOn: '2026-05-01',
          notes: 'outlet',
        }),
        t().pool,
      ),
    );
    expect(res.status).toBe(201);
    const { line } = await json<{ line: TileLineView }>(res);
    expect(line).toMatchObject({
      fieldId: westId,
      fieldName: 'West 40',
      kind: 'main',
      sizeIn: 6,
      depthFt: 3.5,
      installedOn: '2026-05-01',
      origin: 'manual',
      source: 'app',
      editable: true,
    });
    expect(line.geometry.type).toBe('MultiLineString');
    expect(line.lengthFt).toBeGreaterThan(700);
    expect(await layersSeq()).toBe(before + 1);

    const { z, x, y } = tileFor(-84.0595, 41.8915, 15);
    const mvt = await t().pool.query<{ mvt: Buffer }>(
      'select app.mvt_tile_lines($1, $2, $3) as mvt',
      [z, x, y],
    );
    const layers = decodeMvt(new Uint8Array(mvt.rows[0]?.mvt ?? Buffer.alloc(0)));
    expect(layers[0]?.features.map((f) => f.properties.id)).toContain(line.id);

    const list = await as('viewer', () =>
      handleListTileLines(req('GET', `/api/tile-lines?fieldId=${westId}`), t().pool),
    );
    expect((await json<{ lines: TileLineView[] }>(list)).lines.map((l) => l.id)).toEqual([line.id]);
  });

  test('validation: bad JSON, bad shapes and unknown fields are 400 and store nothing', async () => {
    const bodies: unknown[] = [
      '{nope',
      { geometry: { type: 'LineString', coordinates: [[-84, 41.9]] } },
      { geometry: { type: 'Polygon', coordinates: [] } },
      { geometry: inWest, kind: 'drain' },
      { geometry: inWest, sizeIn: -4 },
      { geometry: inWest, installedOn: 'yesterday' },
      { geometry: inWest, fieldId: '00000000-0000-4000-8000-000000000000' },
      { geometry: inWest, extra: true },
    ];
    for (const b of bodies) {
      const res = await as('owner', () =>
        handleCreateTileLine(req('POST', '/api/tile-lines', b), t().pool),
      );
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    const n = await t().pool.query('select count(*)::int as n from farm.tile_lines');
    expect(n.rows[0]?.n).toBe(1);
  });

  test('edit: attributes at the version read; a stale version is 409; reshaping moves the field', async () => {
    const list = await as('manager', () =>
      handleListTileLines(req('GET', `/api/tile-lines?bbox=${BBOX}`), t().pool),
    );
    const [line] = (await json<{ lines: TileLineView[] }>(list)).lines;
    if (!line) throw new Error('no line');
    const before = await layersSeq();
    const edited = await as('manager', () =>
      handleUpdateTileLine(
        req('PATCH', `/api/tile-lines/${line.id}`, {
          version: line.version,
          sizeIn: 8,
          notes: null,
        }),
        line.id,
        t().pool,
      ),
    );
    expect(edited.status).toBe(200);
    const after = (await json<{ line: TileLineView }>(edited)).line;
    expect(after).toMatchObject({ sizeIn: 8, notes: null, depthFt: 3.5, fieldId: westId });
    expect(after.version).not.toBe(line.version);
    expect(await layersSeq()).toBe(before + 1);

    const stale = await as('manager', () =>
      handleUpdateTileLine(
        req('PATCH', `/api/tile-lines/${line.id}`, { version: line.version, sizeIn: 10 }),
        line.id,
        t().pool,
      ),
    );
    expect(stale.status).toBe(409);

    const moved = await as('owner', () =>
      handleUpdateTileLine(
        req('PATCH', `/api/tile-lines/${line.id}`, { version: after.version, geometry: inEast }),
        line.id,
        t().pool,
      ),
    );
    expect(moved.status).toBe(200);
    expect((await json<{ line: TileLineView }>(moved)).line).toMatchObject({
      fieldId: eastId,
      fieldName: 'East 40',
      sizeIn: 8,
    });

    expect(
      (
        await as('driver', () =>
          handleUpdateTileLine(
            req('PATCH', `/api/tile-lines/${line.id}`, { version: 'x' }),
            line.id,
            t().pool,
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await as('manager', () =>
          handleUpdateTileLine(
            req('PATCH', '/api/tile-lines/nope', { version: 'x' }),
            'nope',
            t().pool,
          ),
        )
      ).status,
    ).toBe(404);
  });

  test('a pinned field wins over the shape; null unpins', async () => {
    const created = await as('manager', () =>
      handleCreateTileLine(
        req('POST', '/api/tile-lines', { geometry: inWest, fieldId: eastId }),
        t().pool,
      ),
    );
    const { line } = await json<{ line: TileLineView }>(created);
    expect(line.fieldId).toBe(eastId);
    const unpinned = await as('manager', () =>
      handleUpdateTileLine(
        req('PATCH', `/api/tile-lines/${line.id}`, { version: line.version, fieldId: null }),
        line.id,
        t().pool,
      ),
    );
    expect((await json<{ line: TileLineView }>(unpinned)).line.fieldId).toBe(westId);
  });

  test('Deere lines are read-only; delete needs the current version', async () => {
    const deere = await t().admin.query<{ id: string; v: string }>(
      `insert into farm.tile_lines (geom, origin, source, source_id)
       values (extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($1), 4326)),
               'deere_tile_plow', 'deere', 'plow-1')
       returning id::text,
                 to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as v`,
      [JSON.stringify(inEast)],
    );
    const d = deere.rows[0] as { id: string; v: string };
    const patch = await as('owner', () =>
      handleUpdateTileLine(
        req('PATCH', `/api/tile-lines/${d.id}`, { version: d.v, kind: 'main' }),
        d.id,
        t().pool,
      ),
    );
    expect(patch.status).toBe(403);
    const del = await as('owner', () =>
      handleDeleteTileLine(
        req('DELETE', `/api/tile-lines/${d.id}?version=${encodeURIComponent(d.v)}`),
        d.id,
        t().pool,
      ),
    );
    expect(del.status).toBe(403);
    const listed = await as('viewer', () =>
      handleListTileLines(req('GET', `/api/tile-lines?bbox=${BBOX}`), t().pool),
    );
    expect(
      (await json<{ lines: TileLineView[] }>(listed)).lines.find((l) => l.id === d.id)?.editable,
    ).toBe(false);

    const app = (
      await json<{ lines: TileLineView[] }>(
        await as('viewer', () =>
          handleListTileLines(req('GET', `/api/tile-lines?fieldId=${eastId}`), t().pool),
        ),
      )
    ).lines.find((l) => l.source === 'app');
    if (!app) throw new Error('no app line');
    expect(
      (
        await as('manager', () =>
          handleDeleteTileLine(req('DELETE', `/api/tile-lines/${app.id}`), app.id, t().pool),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await as('manager', () =>
          handleDeleteTileLine(
            req('DELETE', `/api/tile-lines/${app.id}?version=old`),
            app.id,
            t().pool,
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await as('viewer', () =>
          handleDeleteTileLine(
            req('DELETE', `/api/tile-lines/${app.id}?version=${encodeURIComponent(app.version)}`),
            app.id,
            t().pool,
          ),
        )
      ).status,
    ).toBe(403);
    const before = await layersSeq();
    const ok = await as('manager', () =>
      handleDeleteTileLine(
        req('DELETE', `/api/tile-lines/${app.id}?version=${encodeURIComponent(app.version)}`),
        app.id,
        t().pool,
      ),
    );
    expect(ok.status).toBe(200);
    expect(await layersSeq()).toBe(before + 1);
    const gone = await as('manager', () =>
      handleDeleteTileLine(
        req('DELETE', `/api/tile-lines/${app.id}?version=${encodeURIComponent(app.version)}`),
        app.id,
        t().pool,
      ),
    );
    expect(gone.status).toBe(404);
  });

  test('a body over 4 MB is refused before parsing', async () => {
    const big = `{"notes":"${'x'.repeat(4 * 1024 * 1024 + 10)}"}`;
    const res = await as('manager', () =>
      handleCreateTileLine(req('POST', '/api/tile-lines', big), t().pool),
    );
    expect(res.status).toBe(413);
  });
});
