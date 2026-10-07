import argon2 from 'argon2';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withTenantTransaction, type Database } from '../../database/pool.js';
import { AppError, forbidden } from '../../shared/errors.js';
import type { AuthContext } from './auth.types.js';

export const confirmationPasswordSchema=z.string().min(1).max(200);

export async function verifyManagerPassword(database:Database,auth:AuthContext,password:string):Promise<void>{
  if(auth.role!=='TENANT_MANAGER')throw forbidden();
  const valid=await withTenantTransaction(database,auth,async client=>{
    const row=(await client.query<{password_hash:string}>(`SELECT u.password_hash FROM users u
      JOIN tenant_users membership ON membership.user_id=u.id
      WHERE u.id=$1 AND u.status='ACTIVE' AND membership.tenant_id=$2
        AND membership.status='ACTIVE' AND membership.role='TENANT_MANAGER'`,[auth.userId,auth.tenantId])).rows[0];
    return row ? argon2.verify(row.password_hash,password).catch(()=>false) : false;
  });
  if(!valid)throw new AppError(403,'CONFIRMATION_PASSWORD_INVALID','A senha de confirmação não confere. Use sua senha atual de acesso.');
}

export function confirmManagerPassword(database:Database){
  return async(request:FastifyRequest)=>{
    const {confirmationPassword}=z.object({confirmationPassword:confirmationPasswordSchema}).parse(request.body);
    await verifyManagerPassword(database,request.auth,confirmationPassword);
  };
}
