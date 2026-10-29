import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withRuntimeTransaction, type Database } from '../../database/pool.js';
import { hashToken } from '../auth/token.service.js';
import { parseIdempotencyKey, withIdempotency } from '../../shared/idempotency.js';
import { seedFinanceCategories } from './finance.service.js';
import { createMobileExpense, expenseBearer, expenseIdentity, expenseStore, loginExpenseDevice, mobileExpenseInput } from './mobile-expenses.service.js';

export async function mobileExpenseRoutes(app: FastifyInstance, db: Database) {
  // Separate authentication surface; no normal identity/tenant tokens are issued here.
  await app.register(async scoped => {
    scoped.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });
    scoped.post('/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async req => {
      const input = z.object({ email: z.string().trim().email().toLowerCase(), password: z.string().min(8).max(200) }).strict().parse(req.body);
      return withRuntimeTransaction(db, c => loginExpenseDevice(c, input.email, input.password));
    });
    scoped.get('/session', async req => withRuntimeTransaction(db, async c => {
      const identity = await expenseIdentity(c, expenseBearer(req.headers.authorization));
      return { user: { id: identity.userId, name: identity.name }, units: identity.units };
    }));
    scoped.post('/logout', async (req, reply) => {
      const hash = hashToken(expenseBearer(req.headers.authorization));
      await withRuntimeTransaction(db, async c => {
        await c.query("SELECT set_config('app.expense_hash',$1,true)", [hash]);
        await c.query('UPDATE mobile_expense_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [hash]);
      });
      return reply.code(204).send();
    });
    scoped.get('/stores/:storeId/categories', async req => withRuntimeTransaction(db, async c => {
      const identity = await expenseIdentity(c, expenseBearer(req.headers.authorization));
      const { storeId } = z.object({ storeId: z.uuid() }).parse(req.params);
      await expenseStore(c, identity, storeId);
      return { data: (await c.query(`SELECT id,name,direction,dre_group AS "dreGroup" FROM commerce_finance_categories
        WHERE store_id=$1 AND direction='OUT' ORDER BY name`, [storeId])).rows };
    }));
    for (const action of ['entries', 'defaults'] as const) {
      scoped.post('/stores/:storeId/' + action, async (req, reply) => {
        const token = expenseBearer(req.headers.authorization);
        const { storeId } = z.object({ storeId: z.uuid() }).parse(req.params);
        const input = action === 'entries' ? mobileExpenseInput.parse(req.body) : z.object({}).strict().parse(req.body);
        const key = parseIdempotencyKey(req.headers['idempotency-key']);
        const result = await withRuntimeTransaction(db, async c => {
          const identity = await expenseIdentity(c, token);
          const auth = await expenseStore(c, identity, storeId);
          const operation = 'commerce.finance.mobile.' + action;
          const saved = await withIdempotency(c, auth, key, operation, { storeId, input }, async () => ({
            statusCode: 200, body: action === 'entries'
              ? await createMobileExpense(c, auth, storeId, mobileExpenseInput.parse(input))
              : await seedFinanceCategories(c, auth, storeId),
          }));
          // A device can retry a saved request weeks later. Keep the financial
          // receipt beyond normal short-lived API idempotency retention.
          await c.query("UPDATE idempotency_keys SET expires_at='infinity' WHERE tenant_id=$1 AND idempotency_key=$2 AND operation=$3",
            [auth.tenantId, key, operation]);
          return saved;
        });
        return reply.header('Idempotency-Replayed', String(result.replayed)).code(result.statusCode).send(result.body);
      });
    }
  }, { prefix: '/mobile-expenses' });
}
