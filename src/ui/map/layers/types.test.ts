import { describe, expect, test } from 'vitest';
import { validateSpec } from './apply';
import { customersLayer, fieldsLayer, fleetLayer } from './builtin';
import { LAYER_DEFS } from './registry';
import { row, soilsDef } from './test-fixtures';
import {
  absoluteUrl,
  LAYER_GROUP_LABELS,
  LAYER_GROUPS,
  type LayerDef,
  resolveLayers,
} from './types';

describe('resolveLayers', () => {
  test('joins rows by key, in rail order, with row overrides', () => {
    const resolved = resolveLayers(
      [fleetLayer, soilsDef, fieldsLayer],
      [
        row('soils', {
          defaultVisible: true,
          legend: { items: [{ label: 'x', swatch: 'fill' }] },
        }),
        row('orphan'),
      ],
    );
    expect(resolved.map((r) => r.def.key)).toEqual(['fields', 'soils', 'fleet']);
    const soils = resolved[1];
    expect(soils?.status).toBe('ready');
    expect(soils?.defaultVisible).toBe(true);
    expect(soils?.legend?.items[0]?.label).toBe('x');
  });

  test('a built layer without its row is missing; a cache-policy mismatch is never drawn', () => {
    expect(resolveLayers([soilsDef], [])[0]?.status).toBe('missing');
    expect(resolveLayers([soilsDef], [row('soils', { cachePolicy: 'private' })])[0]?.status).toBe(
      'mismatch',
    );
    expect(resolveLayers([customersLayer], [])[0]?.status).toBe('ready');
  });

  test('a key defined twice is a programming error', () => {
    expect(() => resolveLayers([soilsDef, soilsDef], [])).toThrow(/twice/);
  });
});

describe('the registry', () => {
  test('keys are unique, groups known, MapLibre specs follow the id rules', () => {
    const keys = LAYER_DEFS.map((d: LayerDef) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of LAYER_DEFS) {
      expect(LAYER_GROUPS).toContain(d.group);
      if (d.render === 'maplibre') {
        const spec = d.spec({
          origin: 'http://localhost:3000',
          row: null,
          flavor: 'dark',
          variant: 'wall',
        });
        expect(() => validateSpec(d.key, spec)).not.toThrow();
      }
    }
    expect(Object.keys(LAYER_GROUP_LABELS)).toEqual([...LAYER_GROUPS]);
  });

  test('absoluteUrl keeps {z}/{x}/{y} placeholders', () => {
    expect(absoluteUrl('http://192.168.1.20:3000', '/api/tiles/soils/{z}/{x}/{y}?v=1')).toBe(
      'http://192.168.1.20:3000/api/tiles/soils/{z}/{x}/{y}?v=1',
    );
  });
});
