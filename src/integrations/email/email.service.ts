import nodemailer from 'nodemailer';
import type { PoolClient } from 'pg';
import type { AppEnv } from '../../config/env.js';
import type { Database } from '../../database/pool.js';
import { withTransaction } from '../../database/pool.js';
import { encryptPayload, decryptPayload } from '../../shared/encrypted-payload.js';

export interface EmailPayload { to: string; subject: string; text: string }
export const emailConfigured = (env: AppEnv) => Boolean(env.SMTP_HOST && env.SMTP_FROM);
const secret = (env: AppEnv) => env.MESSAGE_PAYLOAD_SECRET || env.TRACKING_TOKEN_PEPPER;

export async function enqueueEmail(client: PoolClient, env: AppEnv, dedupKey: string,
  payload: EmailPayload, expiresAt: Date): Promise<void> {
  await client.query(`INSERT INTO email_jobs(dedup_key, encrypted_payload, expires_at)
    VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
  [dedupKey, encryptPayload(payload, secret(env)), expiresAt]);
}

// SMTP is at-least-once; a stable Message-ID helps providers deduplicate a lost acknowledgement.
// Nothing is marked SENT before the SMTP server accepts the recipient.
export async function processEmailBatch(database: Database, env: AppEnv, limit = 10) {
  await database.query(`UPDATE rastreia.email_jobs SET status='EXPIRED', encrypted_payload=NULL
    WHERE status IN ('PENDING','FAILED') AND expires_at <= now()`);
  if (!emailConfigured(env)) return { sent: 0, configured: false };
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE, tls: { rejectUnauthorized: true },
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
  let sent = 0;
  for (let index = 0; index < limit; index++) {
    const job = await withTransaction(database, async (client) => {
      const result = await client.query<{ id: string; encrypted_payload: string; attempts: number }>(
        `UPDATE rastreia.email_jobs SET attempts = attempts + 1, available_at = now() + interval '5 minutes'
         WHERE id = (SELECT id FROM rastreia.email_jobs WHERE status = 'PENDING'
           AND available_at <= now() AND expires_at > now() ORDER BY created_at
           FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, encrypted_payload, attempts`);
      return result.rows[0];
    });
    if (!job) break;
    try {
      const payload = decryptPayload<EmailPayload>(job.encrypted_payload, secret(env));
      const result = await transport.sendMail({ ...payload, from: env.SMTP_FROM,
        messageId: `<${job.id}@rastreia.app>` });
      if (!result.accepted.length) throw new Error('RECIPIENT_NOT_ACCEPTED');
      await database.query(`UPDATE rastreia.email_jobs SET status='SENT', sent_at=now(),
        encrypted_payload=NULL, last_error=NULL WHERE id=$1`, [job.id]);
      sent++;
    } catch {
      await database.query(`UPDATE rastreia.email_jobs SET status=$2, last_error='SMTP_DELIVERY_FAILED',
        available_at=now()+($3::text || ' seconds')::interval WHERE id=$1`,
      [job.id, job.attempts >= 5 ? 'FAILED' : 'PENDING', Math.min(3600, 30 * 2 ** job.attempts)]);
    }
  }
  await database.query(`UPDATE rastreia.email_jobs SET status='EXPIRED', encrypted_payload=NULL
    WHERE status IN ('PENDING','FAILED') AND expires_at <= now()`);
  return { sent, configured: true };
}
