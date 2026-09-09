import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { setTenantContext, withRuntimeTransaction, withTenantTransaction, type Database } from '../../database/pool.js';
import type { ObjectStorage } from '../../integrations/objects/object-storage.js';
import { decryptPayload, encryptPayload } from '../../shared/encrypted-payload.js';
import { AppError, conflict, forbidden, notFound, unauthorized, validationError } from '../../shared/errors.js';
import { authenticate, requireRoles } from '../auth/auth.guard.js';
import type { AuthContext } from '../auth/auth.types.js';
import { assertIdentity, passwordOptions, setIdentity } from '../auth/identity.service.js';
import { trackingTokenHash } from '../tracking/tracking-token.js';
import { customerPhoneMatches, customerPhoneStorageVariants, normalizeCustomerPhone } from './customer-phone.js';

const anonymousUserId = '00000000-0000-0000-0000-000000000000';
const publicTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const customerTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const registrationSchema = z.object({
  trackingToken: publicTokenSchema,
  email: z.string().trim().email().toLowerCase(),
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().min(2).max(120),
  whatsapp: z.string().trim().min(10).max(20),
  addressLine: z.string().trim().min(3).max(240),
  addressNumber: z.string().trim().min(1).max(30),
  complement: z.string().trim().max(120).nullable().optional(),
  neighborhood: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(120),
  state: z.string().trim().length(2).toUpperCase(),
  postalCode: z.string().trim().regex(/^\d{5}-?\d{3}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  addressConfidence: z.number().min(0).max(1).nullable().optional(),
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

const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  expirationTime: z.coerce.date().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(20).max(512), auth: z.string().min(8).max(256) }),
});

const pushRemovalSchema = z.object({ endpoint: z.url().max(2048) });

interface CustomerSessionScope { tenantId: string; customerId: string }
interface QualificationData {cpf:string;rg:string;documentType:'CNH'|'IDENTITY';documentNumber:string}

const mimeExtensions:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'};
function validMagic(buffer:Buffer,mime:string){if(mime==='application/pdf')return buffer.subarray(0,5).toString()==='%PDF-';
  if(mime==='image/png')return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg')return buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  return mime==='image/webp'&&buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';}
function validCpf(value:string){if(!/^\d{11}$/.test(value)||/^(\d)\1{10}$/.test(value))return false;
  const digit=(size:number)=>{let sum=0;for(let index=0;index<size;index++)sum+=Number(value[index])*(size+1-index);const result=(sum*10)%11;return result===10?0:result;};
  return digit(9)===Number(value[9])&&digit(10)===Number(value[10]);}
function temporaryPassword(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';const bytes=randomBytes(8);
  return [...bytes].map(byte=>alphabet[byte%alphabet.length]).join('');}
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
  callback: (client: PoolClient, scope: CustomerSessionScope) => Promise<T>): Promise<T> {
  if(request.headers.authorization?.startsWith('Bearer ')){
    const identity=await assertIdentity(database,env,request.headers.authorization);
    return withRuntimeTransaction(database,async client=>{await setIdentity(client,identity.userId);
      const account=(await client.query<{must_change_password:boolean}>('SELECT must_change_password FROM users WHERE id=$1',[identity.userId])).rows[0];
      if(account?.must_change_password)throw conflict('Defina sua senha pessoal antes de continuar.');
      const scope=(await client.query<{tenant_id:string;id:string}>(`SELECT tenant_id,id FROM customer_profiles
        WHERE user_id=$1 AND status='ACTIVE' ORDER BY updated_at DESC LIMIT 1`,[identity.userId])).rows[0];
      if(!scope)throw unauthorized('Esta conta não possui um perfil de cliente.');
      await setTenantContext(client,{tenantId:scope.tenant_id,userId:identity.userId});
      return callback(client,{tenantId:scope.tenant_id,customerId:scope.id});});
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

export async function customerRoutes(app: FastifyInstance, database: Database, storage:ObjectStorage, env: AppEnv): Promise<void> {
  const auth = authenticate(env, database);

  app.post('/public/customers/register', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request,reply) => {
    const input = registrationSchema.parse(request.body);
    const trackingHash = trackingTokenHash(input.trackingToken, env.TRACKING_TOKEN_PEPPER);
    return withRuntimeTransaction(database, async client => {
      await client.query("SELECT set_config('app.tracking_hash',$1,true)", [trackingHash]);
      const link = (await client.query<{
        token_id: string;
        tenant_id: string;
        delivery_id: string;
        recipient_phone: string;
        recipient_whatsapp: string | null;
      }>(`SELECT * FROM rastreia.customer_registration_context($1,$2)`,
      [trackingHash, env.CUSTOMER_REGISTRATION_GRACE_SECONDS])).rows[0];
      if (!link) throw notFound('O prazo para criar a conta por este link encerrou ou o link foi substituído.');
      await setTenantContext(client, { tenantId: link.tenant_id, userId: anonymousUserId });
      if (!customerPhoneMatches(input.whatsapp, link.recipient_whatsapp ?? link.recipient_phone)) {
        throw validationError({ whatsapp: 'Use o WhatsApp informado para esta entrega.' });
      }
      const normalized = normalizeCustomerPhone(input.whatsapp);
      if (!/^\d{10,11}$/.test(normalized)) throw validationError({ whatsapp: 'Informe um WhatsApp brasileiro com DDD.' });
      const phoneVariants = customerPhoneStorageVariants(input.whatsapp);
      const profile = (await client.query<{ id: string;user_id:string|null }>(`
        INSERT INTO customer_profiles(tenant_id,first_name,last_name,whatsapp,whatsapp_normalized,address_line,
          address_number,complement,neighborhood,city,state,postal_code,latitude,longitude,address_confidence,source_tracking_token_id,last_order_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
        ON CONFLICT(tenant_id,whatsapp_normalized) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
          whatsapp=EXCLUDED.whatsapp,address_line=EXCLUDED.address_line,address_number=EXCLUDED.address_number,
          complement=EXCLUDED.complement,neighborhood=EXCLUDED.neighborhood,city=EXCLUDED.city,state=EXCLUDED.state,
          postal_code=EXCLUDED.postal_code,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,
          address_confidence=EXCLUDED.address_confidence,status='ACTIVE',consent_at=now(),last_order_at=now()
        RETURNING id,user_id`, [link.tenant_id, input.firstName, input.lastName, input.whatsapp, normalized, input.addressLine,
        input.addressNumber, input.complement ?? null, input.neighborhood, input.city, input.state, input.postalCode,
        input.latitude, input.longitude, input.addressConfidence ?? null, link.token_id])).rows[0]!;
      await client.query(
        'SELECT rastreia.link_customer_delivery_history($1,$2,$3::text[],$4)',
        [profile.id, link.token_id, phoneVariants, env.CUSTOMER_REGISTRATION_GRACE_SECONDS],
      );
      if(profile.user_id)throw conflict('Este cliente já possui uma conta. Entre com o e-mail cadastrado ou redefina a senha.');
      const password=temporaryPassword();const userId=randomUUID();
      const created=(await client.query<{created:boolean}>(`SELECT rastreia.register_customer_identity($1,$2,$3,$4,$5) AS created`,
        [profile.id,userId,`${input.firstName} ${input.lastName}`,input.email,await argon2.hash(password,passwordOptions)])).rows[0]?.created;
      if(!created)throw validationError({email:'Este e-mail já está vinculado a outra conta.'});
      const customer=safeCustomer((await client.query<Record<string,unknown>>(`${customerSelect()} WHERE id=$1`,[profile.id])).rows[0]!,env);
      reply.header('Cache-Control','no-store');return {accountCreated:true,email:input.email,temporaryPassword:password,customer};
    });
  });

  app.get('/customer/me', async request => withCustomerSession(database, env, request, async (client, scope) => {
    const customer = (await client.query<Record<string,unknown>>(`${customerSelect()} WHERE id=$1`, [scope.customerId])).rows[0];
    if (!customer) throw notFound('Cadastro do cliente não encontrado.');
    return safeCustomer(customer,env);
  }));

  app.get('/customer/orders', async request => withCustomerSession(database, env, request, async (client, scope) => ({
    data: (await client.query('SELECT * FROM rastreia.customer_order_history($1)', [scope.customerId])).rows,
  })));

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
    return {
      configured: Boolean(env.PUSH_VAPID_SUBJECT && env.PUSH_VAPID_PUBLIC_KEY && env.PUSH_VAPID_PRIVATE_KEY),
      publicKey: env.PUSH_VAPID_PUBLIC_KEY || null,
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
