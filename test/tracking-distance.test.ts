import { describe, expect, it } from 'vitest';
import { distanceMeters, shouldRevealPublicDestination } from '../src/modules/tracking/tracking.service.js';

describe('public tracking distance', () => {
  it('calculates a stable geodesic distance without exposing route stops', () => {
    const distance = distanceMeters(
      { latitude: -18.9186, longitude: -48.2772 },
      { latitude: -18.9113, longitude: -48.2622 },
    );
    expect(distance).toBeGreaterThan(1_600);
    expect(distance).toBeLessThan(1_900);
  });

  it('returns zero for the same point', () => {
    expect(distanceMeters(
      { latitude: -18.9186, longitude: -48.2772 },
      { latitude: -18.9186, longitude: -48.2772 },
    )).toBe(0);
  });

  it('does not reveal a customer stop while earlier batch stops are pending', () => {
    expect(shouldRevealPublicDestination('IN_ROUTE', true)).toBe(false);
    expect(shouldRevealPublicDestination('IN_ROUTE', false)).toBe(true);
    expect(shouldRevealPublicDestination('ASSIGNED', false)).toBe(false);
  });
});
