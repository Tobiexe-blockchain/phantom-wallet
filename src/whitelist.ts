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
