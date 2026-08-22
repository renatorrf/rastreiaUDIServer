export interface LocationPointInput {
  eventId: string;
  deliveryId: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed?: number | null | undefined;
  heading?: number | null | undefined;
  altitude?: number | null | undefined;
  capturedAt: Date;
}

export interface LocationReference {
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAt: Date;
}

export interface LocationUpdate {
  tenantId: string;
  storeId: string;
  deliveryId: string;
  courierId: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  capturedAt: Date;
  publicVisible: boolean;
}

export interface LocationPublisher {
  publish(update: LocationUpdate): Promise<void>;
}
