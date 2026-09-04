export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export type GeoJsonPosition = [longitude: number, latitude: number];

export function isValidGeoPoint(point: GeoPoint, allowNullIsland = false): boolean {
  return Number.isFinite(point.latitude)
    && Number.isFinite(point.longitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && point.longitude >= -180
    && point.longitude <= 180
    && (allowNullIsland || point.latitude !== 0 || point.longitude !== 0);
}

export function toMapLibreLngLat(point: GeoPoint): GeoJsonPosition {
  return [point.longitude, point.latitude];
}

export function toGeoJsonPosition(point: GeoPoint): GeoJsonPosition {
  return [point.longitude, point.latitude];
}

export function toGeoapifyWaypoint(point: GeoPoint): string {
  return `${point.latitude},${point.longitude}`;
}
