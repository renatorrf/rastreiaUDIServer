import { describe, expect, it } from 'vitest';
import {
  isValidGeoPoint, toGeoJsonPosition, toGeoapifyWaypoint, toMapLibreLngLat,
} from '../src/integrations/geo/geo-point.js';

describe('canonical geographic coordinates', () => {
  const point = { latitude: -18.9186, longitude: -48.2772 };

  it('adapts the domain point to each consumer without implicit inversions', () => {
    expect(toMapLibreLngLat(point)).toEqual([-48.2772, -18.9186]);
    expect(toGeoJsonPosition(point)).toEqual([-48.2772, -18.9186]);
    expect(toGeoapifyWaypoint(point)).toBe('-18.9186,-48.2772');
  });

  it('rejects invalid values and Null Island by default', () => {
    expect(isValidGeoPoint(point)).toBe(true);
    expect(isValidGeoPoint({ latitude: 0, longitude: 0 })).toBe(false);
    expect(isValidGeoPoint({ latitude: Number.NaN, longitude: -48 })).toBe(false);
    expect(isValidGeoPoint({ latitude: 91, longitude: 0 })).toBe(false);
  });
});
