import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { AddressService } from './addresses.js';
import { AppError } from './errors.js';
import type { Secret } from './secret.js';
import type { Sweeper } from './sweeper.js';
import type { WithdrawalService } from './withdrawals.js';

const userId = z.string().min(1).max(100);
const amount = z.string().regex(/^[1-9][0-9]{0,77}$/, 'Amount must be a positive whole number in base units (for example wei).');
const schemas = {
  address: z.object({ userId }).strict(),
  withdrawal: z.object({ userId, asset: z.string().min(2).max(10), amount, to: z.string().min(10).max(100) }).strict(),
  id: z.object({ id: z.string().uuid() }),
  withdrawals: z.object({ userId, limit: z.coerce.number().int().min(1).max(200).default(50) }),
  deposits: z.object({ userId, limit: z.coerce.number().int().min(1).max(200).default(50) }),
};

export interface AppDeps {
  apiKey: Secret;
  addresses: AddressService;
  withdrawals: WithdrawalService;
  sweeper: Sweeper;
  pool: import('pg').Pool;
}

const digest = (v: string) => createHash('sha256').update(v).digest();

/** Internal service API. Callers authenticate with a shared key; do not expose it to browsers. */
export function buildApp(d: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Some fields need fixing.', details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) } });
    }
    if (typeof err.statusCode === 'number' && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: 'BAD_REQUEST', message: 'The request could not be read.' } });
    console.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on our side.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }));

  app.addHook('onRequest', async (req) => {
    if (req.url === '/health') return;
    const given = req.headers['x-api-key'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), digest(d.apiKey.reveal()))) {
      throw new AppError(401, 'UNAUTHORIZED', 'A valid x-api-key header is required.');
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/addresses', async (req, reply) => {
    const body = schemas.address.parse(req.body);
    return reply.status(200).send(await d.addresses.getOrCreate(body.userId));
  });

  app.get<{ Params: { userId: string } }>('/addresses/:userId', async (req) => {
    const found = await d.addresses.get(req.params.userId);
    if (!found) throw new AppError(404, 'NOT_FOUND', 'No deposit address for this user yet.');
    return found;
  });

  app.post('/withdrawals', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 200) throw new AppError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required.');
    const body = schemas.withdrawal.parse(req.body);
    const r = await d.withdrawals.request({ userId: body.userId, asset: body.asset, amount: BigInt(body.amount), to: body.to, key });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.get('/withdrawals', async (req) => {
    const q = schemas.withdrawals.parse(req.query);
    return d.withdrawals.list(q.userId, q.limit);
  });

  app.get('/withdrawals/:id', async (req) => {
    const w = await d.withdrawals.get(schemas.id.parse(req.params).id);
    if (!w) throw new AppError(404, 'NOT_FOUND', 'Withdrawal not found.');
    return w;
  });

  app.get('/deposits', async (req) => {
    const q = schemas.deposits.parse(req.query);
    const res = await d.pool.query(
      `SELECT id, asset, amount::text AS amount, address, tx_hash, block_number, status, created_at FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [q.userId, q.limit],
    );
    return res.rows.map((r) => ({ id: r.id, asset: r.asset, amount: r.amount, address: r.address, txHash: r.tx_hash, blockNumber: Number(r.block_number), status: r.status, createdAt: r.created_at }));
  });

  app.get('/hot-wallet', async () => d.sweeper.hotStatus());

  return app;
}
