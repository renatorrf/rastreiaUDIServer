import type { LocationPointInput, LocationReference } from './location.types.js';

const earthRadiusMeters = 6_371_000;
export const maxLocationAccuracyMeters = 100;
export const maxLocationSpeedMetersPerSecond = 70;
export const maxOfflineAgeMilliseconds = 24 * 60 * 60 * 1000;
export const maxFutureSkewMilliseconds = 30 * 1000;

export interface LocationRejection {
  code: 'INACCURATE' | 'TOO_OLD' | 'FUTURE_TIMESTAMP' | 'OUT_OF_ORDER' | 'IMPOSSIBLE_SPEED' | 'IMPOSSIBLE_JUMP';
  message: string;
}

function radians(value: number): number {
  return value * Math.PI / 180;
}

export function distanceMeters(left: Pick<LocationReference, 'latitude' | 'longitude'>, right: Pick<LocationReference, 'latitude' | 'longitude'>): number {
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

export function validateLocationPoint(
  point: Omit<LocationPointInput, 'deliveryId'>,
  previous?: LocationReference,
  now = new Date(),
): LocationRejection | null {
  if (point.accuracy > maxLocationAccuracyMeters) {
    return { code: 'INACCURATE', message: 'Precisão insuficiente; aguarde um sinal de GPS melhor.' };
  }
  const age = now.getTime() - point.capturedAt.getTime();
  if (age > maxOfflineAgeMilliseconds) {
    return { code: 'TOO_OLD', message: 'Ponto fora da janela de reenvio offline.' };
  }
  if (age < -maxFutureSkewMilliseconds) {
    return { code: 'FUTURE_TIMESTAMP', message: 'Horário do dispositivo está adiantado.' };
  }
  if (point.speed !== null && point.speed !== undefined && point.speed > maxLocationSpeedMetersPerSecond) {
    return { code: 'IMPOSSIBLE_SPEED', message: 'Velocidade informada incompatível com a operação.' };
  }
  if (previous) {
    const elapsedSeconds = (point.capturedAt.getTime() - previous.capturedAt.getTime()) / 1000;
    if (elapsedSeconds <= 0) {
      return { code: 'OUT_OF_ORDER', message: 'Ponto anterior à última posição aceita.' };
    }
    const uncertainty = previous.accuracy + point.accuracy;
    const effectiveDistance = Math.max(0, distanceMeters(previous, point) - uncertainty);
    if (effectiveDistance / elapsedSeconds > maxLocationSpeedMetersPerSecond) {
      return { code: 'IMPOSSIBLE_JUMP', message: 'Salto de localização incompatível com o tempo decorrido.' };
    }
  }
  return null;
}

export function shouldSampleLocation(point: LocationPointInput, previous?: LocationReference): boolean {
  if (!previous) return true;
  const elapsedSeconds = (point.capturedAt.getTime() - previous.capturedAt.getTime()) / 1000;
  return elapsedSeconds >= 30 || distanceMeters(previous, point) >= 100;
}
