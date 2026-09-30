import argon2 from 'argon2';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import { setTenantContext } from '../../database/pool.js';
import { conflict, notFound, unauthorized } from '../../shared/errors.js';
import { trackingTokenHash } from '../tracking/tracking-token.js';
import { customerPhoneStorageVariants, normalizeCustomerPhone } from './customer-phone.js';
import { preregisterCustomer, type CustomerOrderData } from './customer-preregistration.js';

const anonymous = '00000000-0000-0000-0000-000000000000';
export interface ActivationProfile { id: string; user_id: string | null; first_name: string; whatsapp_normalized: string }

export async function prepareCustomerActivation(client: PoolClient, env: AppEnv, token: string, userId = anonymous) {
  const hash = trackingTokenHash(token, env.TRACKING_TOKEN_PEPPER);
  const link = (await client.query<{ token_id: string; tenant_id: string; delivery: CustomerOrderData }>(
    'SELECT * FROM rastreia.customer_activation_order($1,$2)', [hash, env.CUSTOMER_REGISTRATION_GRACE_SECONDS])).rows[0];
  if (!link) throw notFound('Este link não permite mais ativar uma conta. Peça um novo link à loja.');
  await setTenantContext(client, { tenantId: link.tenant_id, userId });
  const id = await preregisterCustomer(client, link.tenant_id, link.delivery);
  if (!id) throw conflict('Peça à loja para conferir seu nome e WhatsApp no pedido antes de ativar sua conta.');
  const profile = (await client.query<ActivationProfile>(`SELECT id,user_id,first_name,whatsapp_normalized
    FROM customer_profiles WHERE id=$1 AND status='ACTIVE' FOR UPDATE`, [id])).rows[0];
  if (!profile || profile.whatsapp_normalized !== normalizeCustomerPhone(link.delivery.recipientWhatsapp || link.delivery.recipientPhone)) {
    throw unauthorized();
  }
  return { profile, hash, tokenId: link.token_id };
}

export async function linkActivationHistory(client: PoolClient, env: AppEnv, profile: ActivationProfile, tokenId: string) {
  await client.query('UPDATE customer_profiles SET source_tracking_token_id=$2 WHERE id=$1', [profile.id, tokenId]);
  await client.query('SELECT rastreia.link_customer_delivery_history($1,$2,$3::text[],$4)',
    [profile.id,tokenId,customerPhoneStorageVariants(profile.whatsapp_normalized),env.CUSTOMER_REGISTRATION_GRACE_SECONDS]);
}

export async function activateCustomer(client: PoolClient, env: AppEnv, token: string, password: string, passwordOptions: Parameters<typeof argon2.hash>[1]) {
  const { profile, hash, tokenId } = await prepareCustomerActivation(client, env, token);
  if (profile.user_id) throw conflict('Você já possui uma conta. Entre com sua senha; este link não redefine senhas.');
  await linkActivationHistory(client, env, profile, tokenId);
  const created = (await client.query<{ id: string | null }>(
    'SELECT rastreia.activate_customer_password($1,$2,$3,$4) AS id',
    [profile.id,hash,env.CUSTOMER_REGISTRATION_GRACE_SECONDS,await argon2.hash(password,passwordOptions)])).rows[0]?.id;
  if (!created) throw conflict('Já existe uma conta para este WhatsApp. Entre com sua senha para vincular o pedido.');
  return { accountCreated: true as const, whatsapp: profile.whatsapp_normalized };
}
