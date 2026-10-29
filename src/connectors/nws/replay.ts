/**
 * NWS replay (CONNECTOR_WEATHER=replay; docs/contracts-m1.md §10): the live client against the
 * fixtures below through the replay transport (src/connectors/replay.ts), recorded first (none
 * yet: `pnpm connectors:record`, 1f), then the doc-derived ones (./fixtures/build.ts). Imported
 * statically so the JSON ships in the build.
 *
 * One NWS-specific rule: `/points/{lat},{lon}` is keyed on coordinates, which no fixture can
 * list for every field, so the transport answers ANY point with the fixture's one point
 * (REPLAY_POINT): the whole farm shares one grid cell in replay. Everything else matches as
 * the shared transport says (method + path + required query values).
 */
import { createReplayFetch, type ReplayFetchOptions, type ReplayFixture } from '../replay';
import { REPLAY_POINT } from './fixtures/build';
import forecast from './fixtures/doc-derived/forecast/01-gridpoint.json';
import observations from './fixtures/doc-derived/observations/01-station-observations.json';
import points from './fixtures/doc-derived/points/01-point.json';
import stations from './fixtures/doc-derived/stations/01-gridpoint-stations.json';

const recorded: ReplayFixture[] = [];

const docDerived = [points, stations, forecast, observations] as unknown as ReplayFixture[];

export const nwsReplayFixtures: readonly ReplayFixture[] = [...recorded, ...docDerived];

const POINTS_RE = /\/points\/[^/]+$/;

/** The replay `fetch` for the NWS client (any /points/… answers as REPLAY_POINT). */
export function nwsReplayFetch(
  opts: ReplayFetchOptions = {},
  fixtures: readonly ReplayFixture[] = nwsReplayFixtures,
): typeof fetch {
  const inner = createReplayFetch(fixtures, opts);
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (POINTS_RE.test(url.pathname)) {
      url.pathname = url.pathname.replace(
        POINTS_RE,
        `/points/${REPLAY_POINT.lat},${REPLAY_POINT.lng}`,
      );
    }
    return inner(url.toString(), init);
  };
}
