import { Queue, Worker } from 'bullmq';
import type { WalletConfig } from './config.js';
import type { WithdrawalService } from './withdrawals.js';

export const QUEUE_NAME = 'withdrawals';

export function redisOptions(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null as null,
  };
}

export interface WithdrawalQueue {
  enqueue(id: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Withdrawals are sent one at a time through BullMQ. The job id is the withdrawal id, so queueing the same
 * withdrawal twice runs it once. Retries use exponential backoff, and the final failure marks the withdrawal failed.
 */
export function createWithdrawalQueue(config: Pick<WalletConfig, 'redisUrl' | 'withdrawalAttempts' | 'retryBackoffMs'>, service: WithdrawalService): WithdrawalQueue {
  const connection = redisOptions(config.redisUrl);
  const queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: { attempts: config.withdrawalAttempts, backoff: { type: 'exponential', delay: config.retryBackoffMs }, removeOnComplete: 1000, removeOnFail: 5000 },
  });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => service.process(job.data.id as string, { attempt: job.attemptsMade + 1, maxAttempts: config.withdrawalAttempts }),
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    if (job && job.attemptsMade >= config.withdrawalAttempts) {
      service.markFailed(job.data.id as string, `Gave up after ${job.attemptsMade} attempts: ${err.message}`).catch(() => undefined);
    }
  });
  worker.on('error', (err) => console.error(`queue worker error: ${err.message}`));

  return {
    async enqueue(id) {
      await queue.add('send', { id }, { jobId: id });
    },
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
