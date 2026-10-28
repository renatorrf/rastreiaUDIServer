import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { decryptPayload, encryptPayload } from '../../shared/encrypted-payload.js';
import { AppError,conflict } from '../../shared/errors.js';

export const companyProviders=['WEB_PUSH','WHATSAPP','SMS','IFOOD','BTG'] as const;
export type CompanyProvider=(typeof companyProviders)[number];
export interface ResolvedCompanyService {
  provider:CompanyProvider;enabled:boolean;source:'company'|'environment';values:Record<string,string|boolean|number>;version?:number;
}

const encryptionKey=(env:AppEnv)=>env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER;

function environmentValues(env:AppEnv,provider:CompanyProvider):ResolvedCompanyService {
  if(provider==='BTG')return {provider,enabled:false,source:'company',version:0,values:{mode:'sandbox',clientId:''}};
  const values:Record<string,string|boolean|number>=provider==='WEB_PUSH'?{
    subject:env.PUSH_VAPID_SUBJECT,publicKey:env.PUSH_VAPID_PUBLIC_KEY,privateKey:env.PUSH_VAPID_PRIVATE_KEY,
    appUrl:env.PUSH_APP_URL||env.PUSH_DEFAULT_OPEN_URL,iconUrl:env.PUSH_NOTIFICATION_ICON_URL,badgeUrl:env.PUSH_NOTIFICATION_BADGE_URL,
  }:provider==='WHATSAPP'?{
    phoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID,businessAccountId:env.WHATSAPP_BUSINESS_ACCOUNT_ID,accessToken:env.WHATSAPP_ACCESS_TOKEN,
    webhookVerifyToken:env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,appSecret:env.WHATSAPP_APP_SECRET,graphVersion:env.WHATSAPP_GRAPH_VERSION,
    trackingTemplate:env.WHATSAPP_TRACKING_TEMPLATE,templateLanguage:env.WHATSAPP_TEMPLATE_LANGUAGE,
  }:provider==='SMS'?{provider:env.SMS_PROVIDER,apiUrl:env.SMS_API_URL,apiKey:env.SMS_API_KEY}: {
    mode:env.IFOOD_MODE,clientId:env.IFOOD_CLIENT_ID,clientSecret:env.IFOOD_CLIENT_SECRET,baseUrl:env.IFOOD_BASE_URL,
    eventsMode:env.IFOOD_EVENTS_MODE,webhookEnabled:env.IFOOD_WEBHOOK_ENABLED,webhookSecret:env.IFOOD_WEBHOOK_SECRET,
    requestTimeoutMs:env.IFOOD_REQUEST_TIMEOUT_MS,
  };
  const enabled=provider==='IFOOD'?env.IFOOD_ENABLED:provider==='WEB_PUSH'?
    Boolean(env.PUSH_VAPID_SUBJECT&&env.PUSH_VAPID_PUBLIC_KEY&&env.PUSH_VAPID_PRIVATE_KEY):provider==='WHATSAPP'?
    (env.COMMUNICATIONS_MOCK||Boolean(env.WHATSAPP_PHONE_NUMBER_ID&&env.WHATSAPP_ACCESS_TOKEN&&env.WHATSAPP_TRACKING_TEMPLATE)):
    (env.COMMUNICATIONS_MOCK||(env.SMS_PROVIDER==='webhook'&&Boolean(env.SMS_API_URL&&env.SMS_API_KEY)));
  return {provider,enabled,source:'environment',values};
}

export async function resolveCompanyService(client:Pick<PoolClient,'query'>,env:AppEnv,companyId:string,provider:CompanyProvider):Promise<ResolvedCompanyService>{
  // One PWA origin uses one VAPID identity. Legacy company rows must not override it.
  if(provider==='WEB_PUSH')return environmentValues(env,provider);
  const available=(await client.query<{available:boolean}>("SELECT to_regclass('rastreia.company_service_settings') IS NOT NULL AS available")).rows[0]?.available;
  if(!available)return environmentValues(env,provider);
  const row=(await client.query<{enabled:boolean;public_config:Record<string,string|boolean|number>;secret_config_encrypted:string|null;version:number}>(
    `SELECT enabled,public_config,secret_config_encrypted,version FROM rastreia.company_service_settings WHERE company_id=$1 AND provider=$2`,[companyId,provider])).rows[0];
  if(!row)return environmentValues(env,provider);
  let secrets:Record<string,string>={};
  if(row.secret_config_encrypted)secrets=decryptPayload<Record<string,string>>(row.secret_config_encrypted,provider==='BTG'?btgEncryptionKey(env):encryptionKey(env));
  return {provider,enabled:row.enabled,source:'company',version:row.version,values:{...row.public_config,...secrets}};
}

function btgEncryptionKey(env:AppEnv){
  if(!env.BTG_ENCRYPTION_SECRET || env.BTG_ENCRYPTION_SECRET.length<32)throw new AppError(503,'BTG_NOT_CONFIGURED','A chave interna BTG ainda não foi configurada no servidor.');
  return env.BTG_ENCRYPTION_SECRET;
}

export function companyServiceConfigured(service:ResolvedCompanyService):boolean{
  const value=(key:string)=>String(service.values[key]??'').trim();
  if(!service.enabled)return false;
  if(service.provider==='WEB_PUSH')return Boolean(value('subject')&&value('publicKey')&&value('privateKey'));
  if(service.provider==='WHATSAPP')return Boolean(value('phoneNumberId')&&value('accessToken')&&value('trackingTemplate'));
  if(service.provider==='SMS')return value('provider')==='webhook'&&Boolean(value('apiUrl')&&value('apiKey'));
  if(service.provider==='BTG')return ['sandbox','production'].includes(value('mode'))&&Boolean(value('clientId')&&value('clientSecret'));
  return value('mode')==='mock'||Boolean(value('clientId')&&value('clientSecret'));
}

export async function saveCompanyService(client:PoolClient,env:AppEnv,input:{tenantId:string;companyId:string;provider:CompanyProvider;
  enabled:boolean;publicConfig:Record<string,string|boolean|number>;secrets:Record<string,string>;updatedBy:string}){
  const existing=(await client.query<{secret_config_encrypted:string|null;public_config:Record<string,unknown>}>(`SELECT secret_config_encrypted,public_config FROM company_service_settings
    WHERE company_id=$1 AND provider=$2 FOR UPDATE`,[input.companyId,input.provider])).rows[0];
  let retained:Record<string,string>={};
  const key=input.provider==='BTG'?btgEncryptionKey(env):encryptionKey(env);
  if(existing?.secret_config_encrypted)retained=decryptPayload<Record<string,string>>(existing.secret_config_encrypted,key);
  if(input.provider==='BTG'&&existing&&(existing.public_config['mode']!==input.publicConfig['mode']||existing.public_config['clientId']!==input.publicConfig['clientId']))retained={};
  const merged={...retained,...Object.fromEntries(Object.entries(input.secrets).filter(([,value])=>value.trim().length>0))};
  if(input.provider==='BTG'){
    const unchanged=existing?.public_config['mode']===input.publicConfig['mode']&&existing?.public_config['clientId']===input.publicConfig['clientId'];
    const previousWebhookId=existing?.public_config['webhookId'];
    if(input.publicConfig['webhookId']===undefined)input.publicConfig['webhookId']=unchanged&&typeof previousWebhookId==='string'?previousWebhookId:'';
    input.publicConfig['webhookId']=String(input.publicConfig['webhookId']).toLowerCase();
    if(input.publicConfig['webhookId']&&!merged['webhookSecret'])throw new AppError(422,'BTG_WEBHOOK_SECRET_REQUIRED','Informe o segredo do webhook desta empresa.');
    if(input.publicConfig['webhookId']){
      // Unique index in 0069 also protects concurrent edits.
      const used=await client.query("SELECT 1 FROM company_service_settings WHERE provider='BTG' AND company_id<>$1 AND lower(public_config->>'webhookId')=$2",[input.companyId,input.publicConfig['webhookId']]);
      if(used.rowCount)throw conflict('Este webhook já está vinculado a outra configuração.');
    }
  }
  if(input.provider==='BTG'&&input.enabled&&(!input.publicConfig['clientId']||!merged['clientSecret']))throw new AppError(422,'BTG_CREDENTIALS_REQUIRED','Informe Client ID e Client Secret desta empresa. Ao trocar o ambiente ou Client ID, informe novamente o Client Secret.');
  const row=(await client.query<{id:string;updated_at:Date}>(`INSERT INTO company_service_settings
    (tenant_id,company_id,provider,enabled,public_config,secret_config_encrypted,updated_by)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
    ON CONFLICT(company_id,provider) DO UPDATE SET enabled=EXCLUDED.enabled,public_config=EXCLUDED.public_config,
      secret_config_encrypted=EXCLUDED.secret_config_encrypted,updated_by=EXCLUDED.updated_by,updated_at=now(),version=company_service_settings.version+1
    RETURNING id,updated_at`,[input.tenantId,input.companyId,input.provider,input.enabled,JSON.stringify(input.publicConfig),
      Object.keys(merged).length?encryptPayload(merged,key):null,input.updatedBy])).rows[0]!;
  return {...row,provider:input.provider,enabled:input.enabled,configuredSecrets:Object.keys(merged)};
}

export function safeCompanyService(service:ResolvedCompanyService){
  const secretKeys:Record<CompanyProvider,string[]>={WEB_PUSH:['privateKey'],WHATSAPP:['accessToken','webhookVerifyToken','appSecret'],
    SMS:['apiKey'],IFOOD:['clientSecret','webhookSecret'],BTG:['clientSecret','webhookSecret']};
  const publicConfig=Object.fromEntries(Object.entries(service.values).filter(([key])=>!secretKeys[service.provider].includes(key)));
  return {provider:service.provider,enabled:service.enabled,source:service.source,configured:companyServiceConfigured(service),publicConfig,
    configuredSecrets:secretKeys[service.provider].filter(key=>Boolean(String(service.values[key]??'').trim()))};
}
