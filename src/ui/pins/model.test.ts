/**
 * The pins UI's pure parts: GeoJSON for the layer (open pins only, `properties.id` = the pin's
 * uuid), colours and labels for every kind, and the popup's text for a Deere flag.
 */
import { describe, expect, test } from 'vitest';
import { PIN_KINDS, type PinView } from '../../domain/pins';
import {
  PIN_KIND_COLORS,
  PIN_KIND_LABELS,
  PIN_TAP_LAYERS,
  pinPopupView,
  pinsFeatureCollection,
} from './model';

const pin = (over: Partial<PinView> = {}): PinView => ({
  id: '0b2c9d1e-1111-4a5b-8c9d-0e1f2a3b4c5d',
  kind: 'rock',
  fieldId: '0b2c9d1e-2222-4a5b-8c9d-0e1f2a3b4c5d',
  fieldName: 'Abernath South 160',
  note: 'Big rock, lift the header',
  category: 'Rocks',
  geometry: { type: 'Point', coordinates: [-84.08, 41.86] },
  source: 'deere_flag',
  readOnly: true,
  resolvedAt: null,
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z',
  ...over,
});

describe('pins model', () => {
  test('every kind has a colour and a label', () => {
    for (const k of PIN_KINDS) {
      expect(PIN_KIND_COLORS[k]).toMatch(/^#[0-9a-f]{6}$/);
      expect(PIN_KIND_LABELS[k]).toBeTruthy();
    }
    expect(PIN_TAP_LAYERS).toEqual(['layer:pins:*']);
  });

  test('the layer data: open pins, properties.id the uuid, colour and category', () => {
    const fc = pinsFeatureCollection([
      pin(),
      pin({ id: 'r', resolvedAt: '2026-06-01T00:00:00.000Z' }),
      pin({
        id: 'n',
        kind: 'note',
        category: null,
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      }),
    ]);
    expect(fc.features.map((f) => f.properties.id)).toEqual([pin().id, 'n']);
    expect(fc.features[0]).toMatchObject({
      type: 'Feature',
      id: pin().id,
      geometry: { type: 'Point' },
      properties: { kind: 'rock', color: PIN_KIND_COLORS.rock, category: 'Rocks' },
    });
    expect(fc.features[1]?.properties.category).toBe('Note');
  });

  test('the popup: category, kind, note, field and where it comes from', () => {
    expect(pinPopupView(pin())).toEqual({
      title: 'Rocks',
      kindLabel: 'Rock',
      color: PIN_KIND_COLORS.rock,
      note: 'Big rock, lift the header',
      field: 'Abernath South 160',
      origin: 'From Operations Center (read-only)',
    });
    expect(pinPopupView(pin({ category: null, fieldName: null, note: null }))).toMatchObject({
      title: 'Rock',
      field: 'Not on a field',
      note: null,
    });
    expect(pinPopupView(pin({ source: 'app', readOnly: false })).origin).toBe('Dropped in the app');
  });
});
