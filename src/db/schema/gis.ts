/**
 * Schema `gis`: public reference data (soils, CDL, parcels, map layers). Created empty in M0;
 * tables arrive with slices 1c-1e. Keep imports relative (drizzle-kit loads this file).
 */
import { pgSchema } from 'drizzle-orm/pg-core';

export const gis = pgSchema('gis');
