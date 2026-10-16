import { createHmac } from 'node:crypto';
import type { Secret } from './secret.js';

export interface DepositEvent {
  id: string;
  userId: string;
  asset: string;
  /** Base units as a decimal string. */
  amount: string;
  address: string;
  txHash: string;
  blockNumber: number;
}

export interface WithdrawalEvent {
  id: string;
  /** The key the caller used when requesting it, so the caller can match the event to its own record. */
  idempotencyKey: string;
  userId: string;
  asset: string;
  amount: string;
  to: string;
  status: 'confirmed' | 'failed';
  txHash: string | null;
  error: string | null;
}

/**
 * Delivery is at-least-once: an event is retried until the sink accepts it, so consumers must
 * deduplicate on `id` (for example by using it as the ledger idempotency key).
 */
export interface EventSink {
  depositConfirmed(event: DepositEvent): Promise<void>;
  withdrawalFinalized(event: WithdrawalEvent): Promise<void>;
}

export class MemorySink implements EventSink {
  deposits: DepositEvent[] = [];
  withdrawals: WithdrawalEvent[] = [];
  async depositConfirmed(e: DepositEvent) {
    this.deposits.push(e);
  }
  async withdrawalFinalized(e: WithdrawalEvent) {
    this.withdrawals.push(e);
  }
}

export class LogSink implements EventSink {
  async depositConfirmed(e: DepositEvent) {
    console.log(`[event] deposit.confirmed id=${e.id} user=${e.userId} ${e.amount} ${e.asset} tx=${e.txHash}`);
  }
  async withdrawalFinalized(e: WithdrawalEvent) {
    console.log(`[event] withdrawal.${e.status} id=${e.id} key=${e.idempotencyKey} user=${e.userId} ${e.amount} ${e.asset}`);
  }
}

/** Posts signed JSON. The receiver verifies `x-signature: sha256=<hmac of the raw body>`. */
export class WebhookSink implements EventSink {
  constructor(
    private readonly url: string,
    private readonly secret: Secret,
  ) {}

  private async post(type: string, id: string, data: object): Promise<void> {
    const body = JSON.stringify({ type, id, data });
    const signature = createHmac('sha256', this.secret.reveal()).update(body).digest('hex');
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': `sha256=${signature}`, 'x-event-id': id },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
  }

  depositConfirmed(e: DepositEvent) {
    return this.post('deposit.confirmed', e.id, e);
  }
  withdrawalFinalized(e: WithdrawalEvent) {
    return this.post(`withdrawal.${e.status}`, e.id, e);
  }
}
