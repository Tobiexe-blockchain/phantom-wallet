import { AppError } from './errors.js';
import type { Secret } from './secret.js';

/** Asks whether a user may withdraw to an address. In production this calls the auth service's whitelist. */
export interface WhitelistChecker {
  isAllowed(userId: string, network: 'ethereum', address: string): Promise<boolean>;
}

/** In-memory checker for development and tests. */
export class StaticWhitelist implements WhitelistChecker {
  private readonly allowed = new Set<string>();
  allow(userId: string, address: string): void {
    this.allowed.add(`${userId}|${address.toLowerCase()}`);
  }
  async isAllowed(userId: string, _network: 'ethereum', address: string): Promise<boolean> {
    return this.allowed.has(`${userId}|${address.toLowerCase()}`);
  }
}

/**
 * Asks the auth service. If it cannot answer, the withdrawal is refused: a missing answer is never a yes.
 */
export class HttpWhitelistChecker implements WhitelistChecker {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: Secret,
    private readonly timeoutMs = 5000,
  ) {}

  async isAllowed(userId: string, network: 'ethereum', address: string): Promise<boolean> {
    const unavailable = () => new AppError(503, 'WHITELIST_UNAVAILABLE', 'The address whitelist could not be checked. Try again shortly.');
    const url = `${this.baseUrl.replace(/\/$/, '')}/internal/whitelist/allowed?userId=${encodeURIComponent(userId)}&network=${network}&address=${encodeURIComponent(address)}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'x-service-key': this.serviceKey.reveal() }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw unavailable();
    }
    if (!res.ok) throw unavailable();
    const body = (await res.json().catch(() => null)) as { allowed?: unknown } | null;
    return body?.allowed === true;
  }
}
