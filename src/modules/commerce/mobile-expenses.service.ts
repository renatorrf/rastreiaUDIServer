import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types.js';
import { setIdentity, type IdentityAccountRow } from '../auth/identity.service.js';
import { hashToken } from '../auth/token.service.js';
import { setTenantContext } from '../../database/pool.js';
import { conflict, forbidden, unauthorized, validationError } from '../../shared/errors.js';
import { requireCommerceStore } from './commerce.service.js';
import { financeEntry, financePayment } from './finance.schemas.js';
import { createFinanceEntry, settleFinanceEntry, today } from './finance.service.js';

export const mobileExpenseInput = financeEntry.extend({
  payment: financePayment.pick({ paidDate: true, method: true }).strict().optional(),
}).strict();
export interface ExpenseUnit { id: string; name: string; tenant_id: string; tenant_name: string; role: string }
export interface ExpenseIdentity { userId: string; sessionId: string; name: string; units: ExpenseUnit[] }

async function profile(c: PoolClient, userId: string) {
  await setIdentity(c, userId);
  const user = (await c.query<IdentityAccountRow & { name: string }>(
    'SELECT id,name,password_hash,status,email_verified_at,must_change_password FROM users WHERE id=$1', [userId])).rows[0];
  if (!user || user.status !== 'ACTIVE' || !user.email_verified_at) throw unauthorized();
  if (user.must_change_password) throw conflict('Defina sua senha pessoal no acesso principal antes de habilitar o lançamento rápido.');
  const units = (await c.query<ExpenseUnit>("SELECT * FROM rastreia.identity_units($1) WHERE role='TENANT_MANAGER'", [userId])).rows;
  if (!units.length) throw forbidden('O lançamento rápido está disponível apenas aos gestores de unidades ativas.');
  return { user, units };
}
export async function loginExpenseDevice(c: PoolClient, email: string, password: string) {
  const account = (await c.query<IdentityAccountRow>('SELECT * FROM rastreia.identity_by_email($1)', [email])).rows[0];
  if (!account || account.status !== 'ACTIVE' || !await argon2.verify(account.password_hash, password)) throw unauthorized();
  const { user, units } = await profile(c, account.id);
  if (user.password_hash !== account.password_hash) throw unauthorized('Sua senha mudou. Entre novamente.');
  const token = randomBytes(32).toString('base64url');
  await c.query(`INSERT INTO mobile_expense_sessions(user_id,token_hash,credential_fingerprint) VALUES($1,$2,$3)`,
    [user.id, hashToken(token), hashToken(user.password_hash)]);
  return { token, user: { id: user.id, name: user.name }, units };
}
export function expenseBearer(header?: string) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '')?.[1];
  if (!token) throw unauthorized('Entre novamente no lançamento rápido.');
  return token;
}
export async function expenseIdentity(c: PoolClient, token: string): Promise<ExpenseIdentity> {
  await c.query("SELECT set_config('app.expense_hash',$1,true)", [hashToken(token)]);
  const session = (await c.query<{ id: string; user_id: string; credential_fingerprint: string }>(
    'SELECT id,user_id,credential_fingerprint FROM mobile_expense_sessions WHERE token_hash=$1 AND revoked_at IS NULL', [hashToken(token)])).rows[0];
  if (!session) throw unauthorized('Este acesso foi encerrado. Entre novamente.');
  const { user, units } = await profile(c, session.user_id);
  if (session.credential_fingerprint !== hashToken(user.password_hash)) throw unauthorized('Sua senha mudou. Entre novamente.');
  return { userId: user.id, name: user.name, sessionId: session.id, units };
}
export async function expenseStore(c: PoolClient, identity: ExpenseIdentity, storeId: string): Promise<AuthContext> {
  const unit = identity.units.find(item => item.id === storeId && item.role === 'TENANT_MANAGER');
  if (!unit) throw forbidden('Esta unidade não está disponível para sua conta.');
  const auth: AuthContext = { userId: identity.userId, sessionId: identity.sessionId, tenantId: unit.tenant_id,
    role: 'TENANT_MANAGER', storeIds: [unit.id] };
  await setTenantContext(c, auth);
  await requireCommerceStore(c, storeId);
  return auth;
}
export async function createMobileExpense(c: PoolClient, auth: AuthContext, store: string, input: z.infer<typeof mobileExpenseInput>) {
  const category = (await c.query<{ direction: string; dre_group: string }>(
    'SELECT direction,dre_group FROM commerce_finance_categories WHERE id=$1 AND store_id=$2', [input.categoryId, store])).rows[0];
  if (category?.direction !== 'OUT') throw validationError({ categoryId: 'Selecione um tipo de saída desta unidade.' });
  if (input.payment && ['COGS', 'DEPRECIATION'].includes(category.dre_group)) throw validationError({ payment: 'Este tipo não movimenta caixa.' });
  if (input.payment && input.payment.paidDate > today()) throw validationError({ payment: 'Use a data efetiva do pagamento, não uma data futura.' });
  const { payment, ...entry } = input;
  const result = await createFinanceEntry(c, auth, store, entry);
  if (payment) await settleFinanceEntry(c, auth, store, result.id, {
    ...payment, expectedVersion: 1, amountCents: entry.amountCents, note: 'Pagamento informado no lançamento rápido.',
  });
  return { ...result, paid: Boolean(payment) };
}
