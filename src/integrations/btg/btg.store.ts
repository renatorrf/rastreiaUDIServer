import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { writeAudit } from '../../shared/audit.js';
import { encryptPayload } from '../../shared/encrypted-payload.js';
import { invalidAuthorization, stateAuth, assertStateCredentials, type BtgState, type BtgTokens,type BtgCredentials } from './btg.oauth.js';
import type { AuthContext } from '../../modules/auth/auth.types.js';
import { resolveCompanyService,companyServiceConfigured } from '../../modules/company-settings/company-settings.service.js';
import { AppError } from '../../shared/errors.js';

export interface BtgStore {
  configuration(this:void,auth:AuthContext,companyId:string):Promise<BtgCredentials>;
  begin(this: void, state: BtgState, stateHash: string, browserHash: string): Promise<void>;
  consume(this: void, state: BtgState, stateHash: string, browserHash: string): Promise<boolean>;
  save(this: void, state: BtgState, stateHash: string, tokens: BtgTokens): Promise<void>;
}
async function checkScope(client: PoolClient, state: Pick<BtgState,'tenantId'|'userId'|'storeIds'|'companyId'>) {
  const result = await client.query<{ allowed: boolean }>(`SELECT
    rastreia.tenant_session_is_current($1,$2,'TENANT_MANAGER',$3) AND
    rastreia.btg_company_in_scope($1,$4) AS allowed`, [state.tenantId, state.userId, state.storeIds, state.companyId]);
  if (!result.rows[0]?.allowed) throw invalidAuthorization();
}
async function credentialsFor(client:PoolClient,env:AppEnv,companyId:string):Promise<BtgCredentials>{
  const settings=await resolveCompanyService(client,env,companyId,'BTG');
  if(!companyServiceConfigured(settings)||!settings.version)throw new AppError(409,'BTG_COMPANY_NOT_CONFIGURED','Configure e habilite o BTG para esta empresa em Integrações.');
  return {mode:settings.values['mode'] as 'sandbox'|'production',clientId:String(settings.values['clientId']),clientSecret:String(settings.values['clientSecret']),version:settings.version};
}
export function createBtgStore(database: Database, env: AppEnv): BtgStore {
  const transaction = <T>(state: BtgState, run: (client: PoolClient) => Promise<T>) =>
    withTenantTransaction(database, stateAuth(state), async client => {
      await checkScope(client, state);
      await client.query('SELECT id FROM company_service_settings WHERE company_id=$1 AND provider=$2 FOR SHARE',[state.companyId,'BTG']);
      assertStateCredentials(state,await credentialsFor(client,env,state.companyId));
      return run(client);
    });
  return {
    configuration:(auth,companyId)=>withTenantTransaction(database,auth,async client=>{
      await checkScope(client,{...auth,companyId});return credentialsFor(client,env,companyId);
    }),
    begin: (state, stateHash, browserHash) => transaction(state, async client => {
      await client.query(`INSERT INTO btg_authorization_sessions(tenant_id,company_id,mode,user_id,state_hash,expires_at,browser_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,mode) DO UPDATE
        SET user_id=EXCLUDED.user_id,state_hash=EXCLUDED.state_hash,expires_at=EXCLUDED.expires_at,browser_hash=EXCLUDED.browser_hash,consumed_at=NULL`,
      [state.tenantId,state.companyId,state.mode,state.userId,stateHash,new Date(state.exp),browserHash]);
    }),
    consume: (state, stateHash, browserHash) => transaction(state, async client => {
      const result = await client.query(`UPDATE btg_authorization_sessions SET consumed_at=now()
        WHERE company_id=$1 AND mode=$2 AND state_hash=$3 AND browser_hash=$4 AND consumed_at IS NULL AND expires_at>now()
        RETURNING company_id`, [state.companyId,state.mode,stateHash,browserHash]);
      return result.rowCount === 1;
    }),
    save: (state, stateHash, tokens) => transaction(state, async client => {
      // Serialize against new authorization attempts; an older callback cannot replace a newer connection.
      const current = await client.query(`SELECT company_id FROM btg_authorization_sessions
        WHERE company_id=$1 AND mode=$2 AND state_hash=$3 AND consumed_at IS NOT NULL AND expires_at>now() FOR UPDATE`,
      [state.companyId,state.mode,stateHash]);
      if (!current.rowCount) throw invalidAuthorization();
      const encrypted = encryptPayload({ ...tokens, tenantId:state.tenantId, companyId:state.companyId,
        mode:state.mode, clientId:state.clientId }, env.BTG_ENCRYPTION_SECRET);
      await client.query(`INSERT INTO btg_authorizations(tenant_id,company_id,mode,tokens_encrypted,expires_at,authorized_by,settings_version)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,mode) DO UPDATE SET tokens_encrypted=EXCLUDED.tokens_encrypted,
        expires_at=EXCLUDED.expires_at,authorized_by=EXCLUDED.authorized_by,settings_version=EXCLUDED.settings_version,updated_at=now(),status='PENDING_ACCOUNT_VALIDATION'`,
      [state.tenantId,state.companyId,state.mode,encrypted,new Date(Date.now()+tokens.expires_in*1000),state.userId,state.settingsVersion]);
      await writeAudit(client,{tenantId:state.tenantId,actorUserId:state.userId,action:'btg.authorization.received',
        entityType:'company',entityId:state.companyId,afterData:{mode:state.mode,status:'PENDING_ACCOUNT_VALIDATION'}});
    }),
  };
}
