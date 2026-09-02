import { getEnv } from '../config/env.js';
import { loadLocalEnv } from '../config/load-env.js';
import { createPool } from '../database/pool.js';
import { createRedisRuntime } from '../infrastructure/redis/redis-runtime.js';
import { processNotificationBatch } from './notification-worker.service.js';
import { releaseMissedCheckins } from '../modules/shifts/shift.service.js';
import { materializeActiveShiftTemplates } from '../modules/shifts/shift-template.service.js';
import { advanceEmergencySearches } from '../modules/shifts/shift-search.service.js';
import { createDueShiftConfirmations, sendDueShiftReminders } from '../modules/shifts/shift-change.service.js';
import { expireDeliveryOffers } from '../modules/offers/offer.service.js';
import { enforceRetentionPolicies } from './retention.service.js';
import { processBillingBatch } from '../modules/billing/billing-worker.service.js';
import { processEmailBatch } from '../integrations/email/email.service.js';
import { createIfoodWorker } from '../integrations/ifood/ifood.worker.js';

loadLocalEnv();
const env = getEnv();
const database = createPool(env);
const redis = await createRedisRuntime(env, (level, message, details) => {
  const line = JSON.stringify({ level, message, ...details });
  if (level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
});
const workerId = `${process.pid}:${crypto.randomUUID()}`;
const processIfood = createIfoodWorker(database,env);
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Integration processing must not depend on SMTP or notification maintenance succeeding.
    try { await processIfood(); } catch { process.stderr.write('ifood worker: batch failed; inspect integration health\n'); }
    const releaseLease = await redis.acquireLease(
      'notification-worker:maintenance', Math.max(30_000, env.NOTIFICATION_WORKER_INTERVAL_MS * 3),
    );
    const runMaintenance = redis.status !== 'ready' || releaseLease !== null;
    let recurring = { generatedSlots: 0 };
    let confirmations = { created: 0 };
    let reminders = { reminded: 0 };
    let offers = { expired: 0 };
    let maintenance = { released: 0 };
    let searches = { advanced: 0 };
    let retention = { ran: false };
    try {
      if (runMaintenance) {
        await database.query(`UPDATE rastreia.courier_service_preferences SET availability_status='OFFLINE',latitude=NULL,longitude=NULL,accuracy=NULL,
          location_authorized_at=NULL,location_expires_at=NULL,updated_at=now() WHERE availability_status='AVAILABLE' AND location_expires_at<=now()`);
        if (env.BILLING_ENABLED) await processBillingBatch(database);
        recurring = await materializeActiveShiftTemplates(database);
        confirmations = await createDueShiftConfirmations(database);
        reminders = await sendDueShiftReminders(database);
        offers = await expireDeliveryOffers(database);
        maintenance = await releaseMissedCheckins(database);
        searches = await advanceEmergencySearches(database);
        retention = await enforceRetentionPolicies(database, env);
      }
    } finally {
      await releaseLease?.();
    }
    const result = await processNotificationBatch(database, env, 25, workerId);
    await processEmailBatch(database, env);
    if (recurring.generatedSlots || confirmations.created || reminders.reminded || offers.expired
        || maintenance.released || searches.advanced || retention.ran
        || result.processed || result.retried || result.deadLettered) {
      process.stdout.write(`${JSON.stringify({ ...recurring, confirmations: confirmations.created,
        reminders: reminders.reminded, offersExpired: offers.expired, ...maintenance, ...searches,
        retention, ...result })}\n`);
    }
  } catch (error) {
    process.stderr.write(`notification worker: ${(error as Error).message}\n`);
  } finally {
    running = false;
  }
}

const interval = setInterval(() => void tick(), env.NOTIFICATION_WORKER_INTERVAL_MS);
void tick();

async function close(): Promise<void> {
  clearInterval(interval);
  await redis.close();
  await database.end();
  process.exit(0);
}

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
