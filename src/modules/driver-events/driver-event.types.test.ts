import { describe,it,expect } from 'vitest';
import { createEventSchema,eventPolicies,eventTypes,recentEventLocation } from './driver-event.types.js';
describe('driver event policy and input',()=>{
  it('has a fixed backend policy for every type',()=>{expect(Object.keys(eventPolicies)).toEqual([...eventTypes]);expect(eventPolicies.ACCIDENT.severity).toBe('CRITICAL');expect(eventPolicies.EMERGENCY_STOP.severity).toBe('CRITICAL');});
  it('keeps police/parking/gate/other internal',()=>{for(const type of ['POLICE_CHECK','PARKING_DIFFICULTY','WAITING_AT_GATE','OTHER'] as const)expect(eventPolicies[type].customerVisibility).toBe('INTERNAL');});
  it('requires bounded description for OTHER and strips markup/control characters',()=>{
    expect(createEventSchema.safeParse({eventType:'OTHER',description:' <b></b> '}).success).toBe(false);
    expect(createEventSchema.safeParse({eventType:'OTHER',description:'a'.repeat(501)}).success).toBe(false);
    expect(createEventSchema.parse({eventType:'OTHER',description:' <b>Rua alagada</b>\u0000 '}).description).toBe('Rua alagada');
    expect(createEventSchema.parse({eventType:'OTHER',description:'Aguardando — assistência “local”'}).description).toBe('Aguardando - assistência "local"');
  });
  it('rejects forged driver/scope/severity/visibility/context fields',()=>{for(const field of ['driverId','tenantId','scope','severity','customerVisibility','currentDeliveryId','occurredAt'])expect(createEventSchema.safeParse({eventType:'FLAT_TIRE',[field]:'forged'}).success).toBe(false);});
  it('uses only recent, finite, sufficiently accurate positions',()=>{
    const now=Date.now(),position={latitude:-18.9,longitude:-48.2,accuracy:10,capturedAt:new Date(now-10000)};
    expect(recentEventLocation(position,now)).toBe(position);
    for(const patch of [{capturedAt:new Date(now-120001)},{capturedAt:new Date(now+30001)},{capturedAt:new Date('invalid')},{accuracy:101},{latitude:NaN},{longitude:181}])expect(recentEventLocation({...position,...patch},now)).toBeNull();
    expect(recentEventLocation(undefined,now)).toBeNull();
  });
});
