import type { PoolClient } from 'pg';
import { describe,expect,it,vi } from 'vitest';
import { storeSchema } from '../stores/store.routes.js';
import { assertCheckinWindow, requireConfirmedCourierPresence, type Workday } from './workday.service.js';
describe('working hours validation',()=>{
  const store={name:'Loja teste',addressLine:'Avenida Brasil',city:'Uberlândia',state:'MG',latitude:-18.9,longitude:-48.2};
  it('accepts overnight hours and rejects partial/equal/invalid times or weekdays',()=>{
    expect(storeSchema.safeParse({...store,openingTime:'20:00',closingTime:'02:00',operatingWeekdays:[5,6]}).success).toBe(true);
    for(const input of [{openingTime:'08:00'},{openingTime:'08:00',closingTime:'08:00'},{openingTime:'25:00',closingTime:'10:00'},{operatingWeekdays:[]},{operatingWeekdays:[1,1]},{operatingWeekdays:[7]}])expect(storeSchema.safeParse({...store,...input}).success).toBe(false);
  });
  it('opens check-in exactly two hours before and closes at the deadline',()=>{
    const day={startsAt:new Date('2026-09-03T20:00:00Z'),endsAt:new Date('2026-09-04T02:00:00Z'),status:'CONFIRMED'} as Workday;
    expect(()=>assertCheckinWindow(day,new Date('2026-09-03T17:59:59Z'))).toThrow();
    expect(()=>assertCheckinWindow(day,new Date('2026-09-03T18:00:00Z'))).not.toThrow();
    expect(()=>assertCheckinWindow(day,new Date('2026-09-04T02:00:00Z'))).toThrow();
    expect(()=>assertCheckinWindow({...day,status:'COMPLETED'},new Date('2026-09-03T21:00:00Z'))).toThrow();
  });
  it('requires a confirmed workday before a courier can receive an assignment',async()=>{
    const query=vi.fn().mockResolvedValue({rowCount:1});
    const allowed={query} as unknown as PoolClient;
    await expect(requireConfirmedCourierPresence(allowed,'tenant','store','courier')).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("day.status = 'CONFIRMED'"),
      ['tenant','store','courier']);

    const denied={query:vi.fn().mockResolvedValue({rowCount:0})} as unknown as PoolClient;
    await expect(requireConfirmedCourierPresence(denied,'tenant','store','courier')).rejects
      .toThrow(/não confirmou presença/);
  });
});
