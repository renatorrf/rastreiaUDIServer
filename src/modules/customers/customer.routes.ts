import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { setTenantContext, withRuntimeTransaction, withTenantTransaction, type Database } from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import type { RouteDirectionsProvider } from '../../integrations/geo/geo-provider.js';
import { decryptPayload, encryptPayload } from '../../shared/encrypted-payload.js';
import { AppError, conflict, forbidden, notFound, unauthorized, validationError } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/auth.types.js';
import { assertIdentity, passwordOptions, setIdentity } from '../auth/identity.service.js';
import { trackingTokenHash } from '../tracking/tracking-token.js';
import { normalizeCustomerPhone } from './customer-phone.js';
import { activateCustomer, prepareCustomerActivation } from './customer-activation.js';
import { companyServiceConfigured,resolveCompanyService } from '../company-settings/company-settings.service.js';
import type { LocationStateStore } from '../locations/location-state.store.js';
import { getCustomerTracking } from '../tracking/tracking.service.js';

const anonymousUserId = '00000000-0000-0000-0000-000000000000';
const publicTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const customerTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const registrationSchema = z.object({
  trackingToken: publicTokenSchema,
  password: z.string().min(8).max(200),
  consent: z.literal(true),
});

const qualificationSchema=z.object({
  cpf:z.string().trim().transform(value=>value.replace(/\D/g,'')).refine(validCpf,'Informe um CPF válido.').optional(),
  rg:z.string().trim().min(5).max(20).optional(),
  documentType:z.enum(['CNH','IDENTITY']).optional(),
  documentNumber:z.string().trim().min(5).max(30).optional(),
});

const customerSearchSchema = z.object({
  whatsapp: z.string().trim().min(8).max(20),
  storeId: z.uuid().optional(),
});
const customerOrderParamsSchema = z.object({ id: z.uuid() });

const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  expirationTime: z.coerce.date().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(20).max(512), auth: z.string().min(8).max(256) }),
});

const pushRemovalSchema = z.object({ endpoint: z.url().max(2048) });

interface CustomerSessionScope { tenantId: string; customerId: string; identityUserId?: string }
interface QualificationData {cpf:string;rg:string;documentType:'CNH'|'IDENTITY';documentNumber:string}

const mimeExtensions:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'};
function validMagic(buffer:Buffer,mime:string){if(mime==='application/pdf')return buffer.subarray(0,5).toString()==='%PDF-';
  if(mime==='image/png')return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg')return buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  return mime==='image/webp'&&buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';}
function validCpf(value:string){if(!/^\d{11}$/.test(value)||/^(\d)\1{10}$/.test(value))return false;
  const digit=(size:number)=>{let sum=0;for(let index=0;index<size;index++)sum+=Number(value[index])*(size+1-index);const result=(sum*10)%11;return result===10?0:result;};
  return digit(9)===Number(value[9])&&digit(10)===Number(value[10]);}
function mask(value:string|undefined,visible=2){if(!value)return null;return `${'*'.repeat(Math.max(0,value.length-visible))}${value.slice(-visible)}`;}
function qualification(row:{qualification_data_encrypted?:string|null;profile_photo_object_key?:string|null;identity_document_object_key?:string|null},env:AppEnv){
  let data:QualificationData|null=null;try{if(row.qualification_data_encrypted)data=decryptPayload<QualificationData>(row.qualification_data_encrypted,env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER);}catch{/* Invalid legacy payload is treated as missing. */}
  const missing:string[]=[];if(!data?.cpf)missing.push('CPF');if(!data?.rg)missing.push('RG');if(!row.profile_photo_object_key)missing.push('foto');
  if(!data?.documentType||!data.documentNumber||!row.identity_document_object_key)missing.push('CNH ou identidade');
  const score=50+(data?.cpf?15:0)+(data?.rg?10:0)+(row.profile_photo_object_key?10:0)+
    (data?.documentType&&data.documentNumber?5:0)+(row.identity_document_object_key?10:0);
  return {score,complete:score===100,missing,cpfMasked:mask(data?.cpf,3),rgMasked:mask(data?.rg,2),
    documentType:data?.documentType??null,documentNumberMasked:mask(data?.documentNumber,3),hasProfilePhoto:Boolean(row.profile_photo_object_key),
    hasIdentityDocument:Boolean(row.identity_document_object_key)};
}

function customerToken(request: FastifyRequest): string {
  const token = request.headers['x-customer-token'];
  if (typeof token !== 'string' || !customerTokenSchema.safeParse(token).success) throw unauthorized('Acesso do cliente inválido.');
  return token;
}

async function withCustomerSession<T>(database: Database, env: AppEnv, request: FastifyRequest,
  callback: (client: PoolClient, scope: CustomerSessionScope) => Promise<T>, deliveryId?: string): Promise<T> {
  if(request.headers.authorization?.startsWith('Bearer ')){
    const identity=await assertIdentity(database,env,request.headers.authorization);
    return withRuntimeTransaction(database,async client=>{await setIdentity(client,identity.userId);
      const account=(await client.query<{must_change_password:boolean}>('SELECT must_change_password FROM users WHERE id=$1',[identity.userId])).rows[0];
      if(account?.must_change_password)throw conflict('Defina sua senha pessoal antes de continuar.');
      const scope=(await client.query<{tenant_id:string;id:string}>(deliveryId
        ? 'SELECT * FROM rastreia.customer_identity_order_scope($1)'
        : `SELECT tenant_id,id FROM customer_profiles WHERE user_id=$1 AND status='ACTIVE' ORDER BY updated_at DESC LIMIT 1`,
        [deliveryId??identity.userId])).rows[0];
      if(!scope){if(deliveryId)throw notFound('Pedido não encontrado.');throw unauthorized('Esta conta não possui um perfil de cliente.');}
      await setTenantContext(client,{tenantId:scope.tenant_id,userId:identity.userId});
      return callback(client,{tenantId:scope.tenant_id,customerId:scope.id,identityUserId:identity.userId});});
  }
  const hash = trackingTokenHash(customerToken(request), env.TRACKING_TOKEN_PEPPER);
  return withRuntimeTransaction(database, async client => {
    await client.query("SELECT set_config('app.customer_session_hash',$1,true)", [hash]);
    const scope = (await client.query<{ tenant_id: string; customer_profile_id: string }>(`
      SELECT tenant_id,customer_profile_id FROM customer_sessions
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() LIMIT 1`, [hash])).rows[0];
    if (!scope) throw unauthorized('A sessão do cliente expirou. Abra novamente um link de rastreio válido.');
    await setTenantContext(client, { tenantId: scope.tenant_id, userId: anonymousUserId });
    await client.query('UPDATE customer_sessions SET last_used_at=now() WHERE token_hash=$1', [hash]);
    return callback(client, { tenantId: scope.tenant_id, customerId: scope.customer_profile_id });
  });
}

function customerSelect() {
  return `SELECT id,first_name AS "firstName",last_name AS "lastName",whatsapp,
    address_line AS "addressLine",address_number AS "addressNumber",complement,neighborhood,city,state,
    postal_code AS "postalCode",qualification_data_encrypted,profile_photo_object_key,identity_document_object_key,
    created_at AS "createdAt",updated_at AS "updatedAt" FROM customer_profiles`;
}

function safeCustomer(row:Record<string,unknown>,env:AppEnv){const {qualification_data_encrypted,profile_photo_object_key,identity_document_object_key,...customer}=row;
  return {...customer,qualification:qualification({qualification_data_encrypted:qualification_data_encrypted as string|null,
    profile_photo_object_key:profile_photo_object_key as string|null,identity_document_object_key:identity_document_object_key as string|null},env)};}

function assertStoreScope(auth: AuthContext, storeId: string | undefined): void {
  if (storeId && auth.role !== 'TENANT_MANAGER' && !auth.storeIds.includes(storeId)) {
    throw forbidden('Você não possui acesso à loja selecionada.');
  }
}

export async function customerRoutes(
  app: FastifyInstance,
  database: Database,
  storage: ObjectStorage,
  env: AppEnv,
  locationState: LocationStateStore,
  directions: RouteDirectionsProvider,
): Promise<void> {
  const auth = authenticate(env, database);

  app.post('/public/customers/registration-context', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request,reply) => {
    const { trackingToken } = z.object({trackingToken:publicTokenSchema}).parse(request.body);
    reply.header('Cache-Control','no-store');
    return withRuntimeTransaction(database, async client => {
      const { profile } = await prepareCustomerActivation(client,env,trackingToken);
      const existing = (await client.query('SELECT id FROM rastreia.customer_identity_by_phone($1)',[profile.whatsapp_normalized])).rows[0];
      return { firstName:profile.first_name,whatsappMasked:`•••• ${profile.whatsapp_normalized.slice(-4)}`,hasAccount:Boolean(profile.user_id||existing) };
    });
  });
  app.post('/public/customers/register', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request,reply) => {
    const input = registrationSchema.parse(request.body);
    reply.header('Cache-Control','no-store');
    return withRuntimeTransaction(database, client => activateCustomer(client,env,input.trackingToken,input.password,passwordOptions));
  });

  app.get('/customer/me', async request => withCustomerSession(database, env, request, async (client, scope) => {
    const customer = (await client.query<Record<string,unknown>>(`${customerSelect()} WHERE id=$1`, [scope.customerId])).rows[0];
    if (!customer) throw notFound('Cadastro do cliente não encontrado.');
    return safeCustomer(customer,env);
  }));

  app.get('/customer/orders', async request => withCustomerSession(database, env, request, async (client, scope) => ({
    data: (await client.query(scope.identityUserId?'SELECT * FROM rastreia.customer_identity_orders()':'SELECT * FROM rastreia.customer_order_history($1)', scope.identityUserId?[]:[scope.customerId])).rows,
  })));

  app.get('/customer/orders/:id/tracking', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = customerOrderParamsSchema.parse(request.params);
    return withCustomerSession(database, env, request, (client, scope) => getCustomerTracking(
      client, env, locationState, directions, scope.tenantId, scope.customerId, id,
    ), id);
  });

  app.patch('/customer/profile',async request=>{
    const input=qualificationSchema.parse(request.body);
    return withCustomerSession(database,env,request,async(client,scope)=>{
      const row=(await client.query<Record<string,unknown>>(`${customerSelect()} WHERE id=$1`,[scope.customerId])).rows[0];
      if(!row)throw notFound('Cadastro do cliente não encontrado.');
      let current:Partial<QualificationData>={};try{if(row.qualification_data_encrypted)current=decryptPayload<QualificationData>(
        row.qualification_data_encrypted as string,env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER);}catch{/* Replace an invalid legacy value. */}
      const merged={...current,...input};
      await client.query(`UPDATE customer_profiles SET qualification_data_encrypted=$2 WHERE id=$1`,
        [scope.customerId,encryptPayload(merged,env.MESSAGE_PAYLOAD_SECRET||env.TRACKING_TOKEN_PEPPER)]);
      return safeCustomer((await client.query<Record<string,unknown>>(`${customerSelect()} WHERE id=$1`,[scope.customerId])).rows[0]!,env);
    });
  });

  for(const [path,column,mimeColumn,folder,imagesOnly] of [
    ['/customer/profile/photo','profile_photo_object_key','profile_photo_mime_type','profile-photo',true],
    ['/customer/profile/identity-document','identity_document_object_key','identity_document_mime_type','identity-document',false],
  ] as const){
    app.post(path,async(request,reply)=>{
      const file=await request.file({limits:{files:1,fileSize:env.PROOF_MAX_FILE_SIZE_BYTES,parts:1}});
      if(!file)throw new AppError(400,'FILE_REQUIRED','Selecione um arquivo.');
      const buffer=await file.toBuffer();const extension=mimeExtensions[file.mimetype];
      if(!extension||(imagesOnly&&file.mimetype==='application/pdf')||!validMagic(buffer,file.mimetype))
        throw new AppError(415,'DOCUMENT_TYPE_NOT_ALLOWED',imagesOnly?'Envie uma foto JPG, PNG ou WebP válida.':'Envie PDF, JPG, PNG ou WebP válido.');
      let storedKey:string|undefined;let previousKey:string|null=null;
      try{
        const customer=await withCustomerSession(database,env,request,async(client,scope)=>{
          const current=(await client.query<Record<string,unknown>>(`${customerSelect()} WHERE id=$1 FOR UPDATE`,[scope.customerId])).rows[0];
          if(!current)throw notFound('Cadastro do cliente não encontrado.');
          previousKey=(current[column] as string|null)??null;
          storedKey=`${scope.tenantId}/customers/${scope.customerId}/${folder}/${randomUUID()}.${extension}`;
          await storage.put(storedKey,buffer);
          await client.query(`UPDATE customer_profiles SET ${column}=$2,${mimeColumn}=$3 WHERE id=$1`,[scope.customerId,storedKey,file.mimetype]);
          return safeCustomer((await client.query<Record<string,unknown>>(`${customerSelect()} WHERE id=$1`,[scope.customerId])).rows[0]!,env);
        });
        if(previousKey)await storage.remove(previousKey);
        return reply.status(201).send(customer);
      }catch(error){if(storedKey)await storage.remove(storedKey);throw error;}
    });
  }

  app.delete('/customer/session', async request => withCustomerSession(database, env, request, async (client) => {
    if(request.headers.authorization?.startsWith('Bearer '))return {revoked:false};
    const hash = trackingTokenHash(customerToken(request), env.TRACKING_TOKEN_PEPPER);
    await client.query('UPDATE customer_sessions SET revoked_at=now() WHERE token_hash=$1', [hash]);
    return { revoked: true };
  }));

  app.get('/customer/push/status', async request => withCustomerSession(database, env, request, async (client, scope) => {
    const row = (await client.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM customer_push_subscriptions WHERE customer_profile_id=$1 AND active`, [scope.customerId])).rows[0];
    const company=(await client.query<{company_id:string}>(`SELECT delivery.company_id FROM deliveries delivery
      WHERE delivery.customer_profile_id=$1 ORDER BY delivery.created_at DESC LIMIT 1`,[scope.customerId])).rows[0];
    const push=await resolveCompanyService(client,env,company?.company_id??'00000000-0000-0000-0000-000000000000','WEB_PUSH');
    return {
      configured: companyServiceConfigured(push),
      publicKey: companyServiceConfigured(push)?String(push.values['publicKey']??''):null,
      activeDevices: Number(row?.count ?? 0),
    };
  }));

  app.put('/customer/push/subscriptions', async request => {
    const input = pushSubscriptionSchema.parse(request.body);
    return withCustomerSession(database, env, request, async (client, scope) => {
      const endpointHash = createHash('sha256').update(input.endpoint).digest('hex');
      const row = (await client.query<{ id: string }>(`INSERT INTO customer_push_subscriptions
        (tenant_id,customer_profile_id,endpoint,endpoint_hash,p256dh,auth_secret,expiration_time,user_agent,active,failure_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,0)
        ON CONFLICT(tenant_id,customer_profile_id,endpoint_hash) DO UPDATE SET endpoint=EXCLUDED.endpoint,
          p256dh=EXCLUDED.p256dh,auth_secret=EXCLUDED.auth_secret,expiration_time=EXCLUDED.expiration_time,
          user_agent=EXCLUDED.user_agent,active=true,failure_count=0,last_failure_at=NULL
        RETURNING id`, [scope.tenantId, scope.customerId, input.endpoint, endpointHash, input.keys.p256dh,
        input.keys.auth, input.expirationTime ?? null, request.headers['user-agent'] ?? null])).rows[0]!;
      return { id: row.id, active: true };
    });
  });

  app.delete('/customer/push/subscriptions', async request => {
    const input = pushRemovalSchema.parse(request.body);
    return withCustomerSession(database, env, request, async (client, scope) => {
      const endpointHash = createHash('sha256').update(input.endpoint).digest('hex');
      const result = await client.query(`UPDATE customer_push_subscriptions SET active=false
        WHERE customer_profile_id=$1 AND endpoint_hash=$2`, [scope.customerId, endpointHash]);
      return { removed: Boolean(result.rowCount) };
    });
  });

  app.get('/customers/search', { preHandler: [auth, requireRoles('TENANT_MANAGER', 'STORE_OPERATOR')] }, async request => {
    const input = customerSearchSchema.parse(request.query);
    assertStoreScope(request.auth, input.storeId);
    const normalized = normalizeCustomerPhone(input.whatsapp);
    if (normalized.length < 8) throw validationError({ whatsapp: 'Digite ao menos 8 números.' });
    return withTenantTransaction(database, request.auth, async client => ({
      data: (await client.query(`SELECT customer.id,customer.first_name AS "firstName",customer.last_name AS "lastName",
        customer.whatsapp,customer.address_line AS "addressLine",customer.address_number AS "addressNumber",
        customer.complement,customer.neighborhood,customer.city,customer.state,customer.postal_code AS "postalCode",
        customer.latitude,customer.longitude,customer.address_confidence::float8 AS "addressConfidence",
        count(delivery.id)::int AS "ordersCount",max(delivery.created_at) AS "lastOrderAt"
        FROM customer_profiles customer JOIN deliveries delivery ON delivery.customer_profile_id=customer.id
        WHERE customer.status='ACTIVE' AND position($1 in customer.whatsapp_normalized)>0
          AND ($2::uuid IS NULL OR delivery.store_id=$2)
          AND ($3::text='TENANT_MANAGER' OR delivery.store_id=ANY($4::uuid[]))
        GROUP BY customer.id ORDER BY max(delivery.created_at) DESC LIMIT 10`,
      [normalized, input.storeId ?? null, request.auth.role, request.auth.storeIds])).rows,
    }));
  });
}
