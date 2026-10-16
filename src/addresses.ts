import type { Pool } from 'pg';
import { deriveDepositAddress } from './hd.js';

export interface DepositAddress {
  userId: string;
  address: string;
  derivationIndex: number;
}

/** Hands out one deposit address per user. Needs only the xpub, never a private key. */
export class AddressService {
  constructor(
    private readonly pool: Pool,
    private readonly xpub: string,
  ) {}

  async get(userId: string): Promise<DepositAddress | null> {
    const res = await this.pool.query('SELECT user_id, address, derivation_index FROM deposit_addresses WHERE user_id = $1', [userId]);
    return res.rows[0] ? this.toAddress(res.rows[0]) : null;
  }

  async getOrCreate(userId: string): Promise<DepositAddress> {
    const existing = await this.get(userId);
    if (existing) return existing;

    const index: number = (await this.pool.query('SELECT nextval(\'deposit_address_index_seq\')::int AS n')).rows[0].n;
    const address = deriveDepositAddress(this.xpub, index);
    const ins = await this.pool.query(
      `INSERT INTO deposit_addresses(user_id, derivation_index, address) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING RETURNING user_id, address, derivation_index`,
      [userId, index, address],
    );
    // Lost a race for the same user: the index we took is simply unused, which is harmless.
    return ins.rows[0] ? this.toAddress(ins.rows[0]) : (await this.get(userId))!;
  }

  private toAddress(r: { user_id: string; address: string; derivation_index: number }): DepositAddress {
    return { userId: r.user_id, address: r.address, derivationIndex: r.derivation_index };
  }
}
