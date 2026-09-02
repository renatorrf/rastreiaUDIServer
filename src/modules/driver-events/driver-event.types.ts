import { z } from 'zod';

export const eventTypes = ['FLAT_TIRE','MECHANICAL_PROBLEM','ACCIDENT','HEAVY_TRAFFIC','ROAD_BLOCKED',
  'POLICE_CHECK','ADDRESS_PROBLEM','CUSTOMER_NOT_FOUND','CUSTOMER_NOT_RESPONDING','PARKING_DIFFICULTY',
  'WAITING_AT_GATE','ORDER_DAMAGED','EMERGENCY_STOP','OTHER'] as const;
export type EventType = typeof eventTypes[number];
interface EventPolicy { label: string; severity: 'INFO'|'WARNING'|'CRITICAL'; deliverySpecific: boolean;
  customerVisibility: 'INTERNAL'|'GENERIC'|'VISIBLE'; affectsEta: boolean }
export const eventPolicies: Record<EventType,EventPolicy> = {
  FLAT_TIRE: {label:'Pneu furado',severity:'WARNING',deliverySpecific:false,customerVisibility:'GENERIC',affectsEta:true},
  MECHANICAL_PROBLEM: {label:'Problema mecânico',severity:'WARNING',deliverySpecific:false,customerVisibility:'GENERIC',affectsEta:true},
  ACCIDENT: {label:'Acidente',severity:'CRITICAL',deliverySpecific:false,customerVisibility:'GENERIC',affectsEta:true},
  HEAVY_TRAFFIC: {label:'Trânsito intenso',severity:'WARNING',deliverySpecific:false,customerVisibility:'GENERIC',affectsEta:true},
  ROAD_BLOCKED: {label:'Via bloqueada',severity:'WARNING',deliverySpecific:false,customerVisibility:'GENERIC',affectsEta:true},
  POLICE_CHECK: {label:'Fiscalização policial',severity:'WARNING',deliverySpecific:false,customerVisibility:'INTERNAL',affectsEta:true},
  ADDRESS_PROBLEM: {label:'Problema no endereço',severity:'WARNING',deliverySpecific:true,customerVisibility:'GENERIC',affectsEta:true},
  CUSTOMER_NOT_FOUND: {label:'Cliente não localizado',severity:'WARNING',deliverySpecific:true,customerVisibility:'GENERIC',affectsEta:true},
  CUSTOMER_NOT_RESPONDING: {label:'Cliente não atende',severity:'WARNING',deliverySpecific:true,customerVisibility:'GENERIC',affectsEta:true},
  PARKING_DIFFICULTY: {label:'Dificuldade para estacionar',severity:'INFO',deliverySpecific:true,customerVisibility:'INTERNAL',affectsEta:true},
  WAITING_AT_GATE: {label:'Aguardando na portaria',severity:'INFO',deliverySpecific:true,customerVisibility:'INTERNAL',affectsEta:true},
  ORDER_DAMAGED: {label:'Problema com pedido',severity:'WARNING',deliverySpecific:true,customerVisibility:'GENERIC',affectsEta:true},
  EMERGENCY_STOP: {label:'Parada emergencial',severity:'CRITICAL',deliverySpecific:false,customerVisibility:'GENERIC',affectsEta:true},
  OTHER: {label:'Outro',severity:'WARNING',deliverySpecific:false,customerVisibility:'INTERNAL',affectsEta:true},
};
export const createEventSchema = z.object({
  eventType: z.enum(eventTypes),
  description: z.string().trim().max(500).transform(text=>Array.from(text.normalize('NFC').replace(/<[^>]*>/g,'')
    .replace(/[\u2010-\u2015]/g,'-').replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"'))
    .filter(char=>char.charCodeAt(0)>=32||char==='\n'||char==='\t').join('').trim()).optional(),
  deliveryId: z.uuid().optional(), batchId: z.uuid().optional(),
  location: z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),
    accuracy:z.number().min(0).max(100),capturedAt:z.iso.datetime()}).strict().optional(),
}).strict().superRefine((input,ctx)=>{
  if(input.eventType==='OTHER'&&(input.description?.length??0)<3)ctx.addIssue({code:'custom',path:['description'],message:'Descreva a ocorrência em pelo menos 3 caracteres.'});
});
export type CreateEventInput = z.infer<typeof createEventSchema>;
export interface DriverEvent {
  id:string;tenantId:string;companyId:string;storeId:string;courierId:string;courierName:string;
  deliveryId:string|null;batchId:string|null;currentDeliveryId:string|null;deliveryReference:string|null;batchLabel:string|null;
  eventType:EventType;scope:'DRIVER'|'BATCH'|'DELIVERY';severity:'INFO'|'WARNING'|'CRITICAL';status:'OPEN'|'RESOLVED'|'CANCELLED';
  description:string|null;latitude:number|null;longitude:number|null;locationCapturedAt:Date|null;occurredAt:Date;
  resolvedAt:Date|null;resolvedByUserId:string|null;createdBy:string;customerVisibility:EventPolicy['customerVisibility'];affectsEta:boolean;
  label:string;
}
export interface DriverEventUpdate { action:'created'|'resolved'|'updated'; event:DriverEvent; deliveryIds:string[] }
export interface DriverEventPublisher { publishEvent(update:DriverEventUpdate):Promise<void> }

export function recentEventLocation<T extends {latitude:number;longitude:number;accuracy:number;capturedAt:Date}>(position:T|undefined, now=Date.now()):T|null {
  if(!position||!Number.isFinite(position.latitude)||!Number.isFinite(position.longitude)||!Number.isFinite(position.accuracy)
    ||Math.abs(position.latitude)>90||Math.abs(position.longitude)>180||position.accuracy<0||position.accuracy>100)return null;
  const age=now-position.capturedAt.getTime();
  return Number.isFinite(age)&&age>=-30_000&&age<=120_000?position:null;
}
