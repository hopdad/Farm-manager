/**
 * The NAIP fixture for machines that can't reach imagery.nationalmap.gov (the build machine's
 * proxy answers 403; CI is offline): `pnpm gis:naip --fixture` and the tests answer every
 * exportImage request with this one 256 × 256 JPEG, so the whole pipeline (tile list, raw cache,
 * PMTiles, storage, registry, the map layer) runs without the network.
 *
 * NOT NAIP DATA: a synthetic image (crop-row stripes, a cross and the words "NAIP FIXTURE",
 * drawn with Pillow), shaped like what exportImage returns for `format=jpg&f=image` (a baseline
 * JPEG, 256 × 256, image/jpeg; ArcGIS REST "Export Image",
 * https://developers.arcgis.com/rest/services-reference/enterprise/export-image/). The build
 * marks a fixture archive (`meta.fixture`) and the rail's legend says so.
 */
import type { FetchLike } from './http';
import { isJpeg } from './naip-tiles';

export const NAIP_FIXTURE_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdB' +
  'RkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09P' +
  'T09PT09PT09PT09PT0//wAARCAEAAQADASIAAhEBAxEB/8QAGgABAQEBAQEBAAAAAAAAAAAABAADAgEFBv/EADoQAAIABAEK' +
  'BgECBAYDAAAAAAABAgMEEbEUITE0QVRxc5KTBRIi0eHwEzVRBkJhkWJjgYKhsiNSwf/EABgBAQEBAQEAAAAAAAAAAAAAAAAC' +
  'AQQD/8QAGxEBAQEAAwEBAAAAAAAAAAAAABEBMTJxEgL/2gAMAwEAAhEDEQA/AHT502OdNlyp0yCOCOJJKNpRK+IR1VUnZ1E5' +
  'Nf42YVra8QqGnZqbFZrid+msh2Q1CXBRr3+8OTd2o7etMrqd4ndbLK6neJ3WwLTTaas1pTPBdSfldTvE7rZZXU7xO62AIXQ/' +
  'K6neJ3Wyyup3id1sAQuh+V1O8TutlldTvE7rYAhdD8rqd4ndbLK6neJ3WwBC6H5XU7xO62WV1O8TutgCF0Pyup3id1ssrqd4' +
  'ndbAELofldTvE7rZZXU7xO62AIXQ/K6neJ3Wyyup3id1sAQuh+V1O8TutlldTvE7rYAhdD8rqd4ndbLK6neJ3WwBC6H5XU7x' +
  'O62WV1O8TutgCF0Pyup3id1ssrqd4ndbAELofldTvE7rZZXU7xO62APUm2kldvQkLocqqqbsqic2/wDGxcidNgnSpc2dMjjj' +
  'jhTTjbUKviA9NHDsiqGuKgXv948UTb8Qp23dubDdviM3arr63rNdn8yLExTad07NHNdr9RzYsWYDeUvo5qmHYpyXV8h2mnZq' +
  'zQdNppp2a0NCvTWQ7IahLgo17/eGK7euSDtNNpqzWlM8ESSQYhAkgxCBJBiECSDEIEkGIQJIMQgSQYhAkgxCBJBiECSDEIEk' +
  'GPUm2kldvQkIEJNuyV2xGamh2Oc10/Jj6aOHZFUNcVAvf7xK22227t6Wwrr6Q227t3bNqPXZHMhxAG9Dr9PzYcUbnKSKzXZ/' +
  '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';

export const NAIP_FIXTURE_JPEG: Uint8Array = Uint8Array.from(
  Buffer.from(NAIP_FIXTURE_JPEG_BASE64, 'base64'),
);

if (!isJpeg(NAIP_FIXTURE_JPEG)) throw new Error('the NAIP fixture is not a JPEG');

/**
 * A fetch that answers like the ImageServer: exportImage → the fixture JPEG (image/jpeg);
 * anything else → a 404 JSON error in ArcGIS's shape. Counts requests (tests).
 */
export function naipFixtureFetch(): FetchLike & { requests: string[] } {
  const requests: string[] = [];
  const f = (async (url: string) => {
    requests.push(url);
    if (/\/ImageServer\/exportImage\?/.test(url) && /[?&]f=image(&|$)/.test(url)) {
      return new Response(Buffer.from(NAIP_FIXTURE_JPEG), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response(JSON.stringify({ error: { code: 404, message: 'Not Found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchLike & { requests: string[] };
  f.requests = requests;
  return f;
}
