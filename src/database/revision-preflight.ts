import { loadLocalEnv } from '../config/load-env.js';
import { getEnv } from '../config/env.js';
import { createPool } from './pool.js';
import { emailConfigured } from '../integrations/email/email.service.js';
loadLocalEnv();
const env=getEnv();const database=createPool(env);
try {
  const migrations=await database.query<{name:string}>('SELECT name FROM rastreia.schema_migrations ORDER BY name DESC LIMIT 3');
  const hierarchy=(await database.query<{ready:boolean}>("SELECT to_regprocedure('rastreia.has_store_access(uuid,uuid)') IS NOT NULL AS ready")).rows[0]!.ready;
  const hasUnits=hierarchy?`EXISTS(SELECT 1 FROM rastreia.stores store WHERE store.tenant_id=member.tenant_id
    AND rastreia.has_store_access(member.user_id,store.id))`:`EXISTS(SELECT 1 FROM rastreia.user_store_access access
    JOIN rastreia.stores store ON store.id=access.store_id WHERE access.tenant_user_id=member.id AND store.status='ACTIVE')`;
  const scope=await database.query(`SELECT count(*)::int AS managers_without_active_units FROM rastreia.tenant_users member
    WHERE member.role='TENANT_MANAGER' AND member.status='ACTIVE'
      AND NOT ${hasUnits}`);
  const residual=await database.query(`SELECT count(*)::int AS rollback_fixture_tenants FROM rastreia.tenants WHERE slug ~ '^revision-[a-f0-9]{12}($|-)'`);
  process.stdout.write(JSON.stringify({migrations:migrations.rows.map(row=>row.name),...scope.rows[0],...residual.rows[0],
    smtpConfigured:emailConfigured(env),publicRegistrationRequested:env.PUBLIC_COURIER_REGISTRATION_ENABLED,
    billingWorkerEnabled:env.BILLING_ENABLED,secureCookies:env.COOKIE_SECURE},null,2)+'\n');
  if(process.argv.includes('--show-unlinked')){
    const unlinked=await database.query(`SELECT account.name AS manager,tenant.name AS company,
      ARRAY(SELECT store.name FROM rastreia.stores store WHERE store.tenant_id=tenant.id AND store.status::text=$1 ORDER BY store.name) AS active_units
      FROM rastreia.tenant_users member JOIN rastreia.users account ON account.id=member.user_id
      JOIN rastreia.tenants tenant ON tenant.id=member.tenant_id WHERE member.role=$2 AND member.status::text=$1
      AND NOT ${hasUnits}`,['ACTIVE','TENANT_MANAGER']);
    process.stdout.write(JSON.stringify(unlinked.rows,null,2)+'\n');
  }
}finally{await database.end();}
