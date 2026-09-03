import { z } from 'zod';

export const workingHoursFields = {
  openingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  closingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  operatingWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine(days => new Set(days).size === days.length, 'Não repita dias da semana.').default([0,1,2,3,4,5,6]),
};
export function validWorkingHours(input: { openingTime?: string | null | undefined; closingTime?: string | null | undefined }): boolean {
  return (!input.openingTime && !input.closingTime)
    || Boolean(input.openingTime && input.closingTime && input.openingTime !== input.closingTime);
}

export const workdaySelect = `SELECT day.id,day.store_id AS "storeId",store.name AS "storeName",
  day.service_date::text AS "serviceDate",day.starts_at AS "startsAt",day.ends_at AS "endsAt",tenant.timezone,
  day.status,day.checkin_at AS "checkinAt",day.checkout_at AS "checkoutAt",day.version,
  store.address_line AS "addressLine",store.address_number AS "addressNumber",store.city,
  day.courier_profile_id AS "courierId",profile.user_id AS "userId",person.name AS "courierName"
  FROM courier_workdays day JOIN stores store ON store.id=day.store_id
  JOIN tenants tenant ON tenant.id=day.tenant_id JOIN courier_profiles profile ON profile.id=day.courier_profile_id
  JOIN users person ON person.id=profile.user_id`;

// Yesterday is included for overnight service. PostgreSQL resolves local wall
// time with the tenant's IANA zone; the server/device timezone is never used.
export const materializeWorkdaysSql = `INSERT INTO courier_workdays
  (tenant_id,store_id,courier_profile_id,service_date,starts_at,ends_at)
  SELECT store.tenant_id,store.id,link.courier_profile_id,dates.day::date,
    (dates.day::date+store.opening_time) AT TIME ZONE tenant.timezone,
    (dates.day::date+store.closing_time+CASE WHEN store.closing_time<store.opening_time THEN interval '1 day' ELSE interval '0' END)
      AT TIME ZONE tenant.timezone
  FROM stores store JOIN tenants tenant ON tenant.id=store.tenant_id
  JOIN courier_store_links link ON link.store_id=store.id AND link.status='ACTIVE'
  JOIN courier_profiles profile ON profile.id=link.courier_profile_id AND profile.status='ACTIVE'
  JOIN users person ON person.id=profile.user_id AND person.status='ACTIVE'
  JOIN tenant_users member ON member.tenant_id=store.tenant_id AND member.user_id=profile.user_id
    AND member.role='COURIER' AND member.status='ACTIVE'
  CROSS JOIN LATERAL generate_series((now() AT TIME ZONE tenant.timezone)::date-1,
    (now() AT TIME ZONE tenant.timezone)::date+2,interval '1 day') dates(day)
  WHERE store.status='ACTIVE' AND tenant.status='ACTIVE' AND store.opening_time IS NOT NULL AND store.closing_time IS NOT NULL
    AND extract(dow FROM dates.day)::int=ANY(store.operating_weekdays)
    AND ($1::uuid IS NULL OR (profile.user_id=$1 AND store_in_scope(store.id)))
  ON CONFLICT(store_id,courier_profile_id,service_date) DO NOTHING`;
