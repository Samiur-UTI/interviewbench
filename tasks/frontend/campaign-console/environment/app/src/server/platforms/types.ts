import type { Credential, Platform, RunItem } from "../../shared/types.ts";

/**
 * One platform integration. Every method throws PlatformError on failure; adapters don't retry
 * (the runner and the circuit breaker decide that).
 */
export interface PlatformAdapter {
  platform: Platform;
  /** The cheapest authenticated call the platform offers. Resolves when the credential works. */
  probe(credential: Credential): Promise<void>;
  /**
   * oauth only: gets a new access token (Google: refresh grant; Meta: token exchange). Throws
   * PlatformError("unauthorized") when that is no longer possible (only Reconnect helps).
   */
  refresh?(credential: Credential): Promise<Credential>;
  send(credential: Credential, item: RunItem): Promise<{ externalId: string }>;
}

/** The adapters a deployment has; a platform without one can't be reached. */
export type PlatformRegistry = Partial<Record<Platform, PlatformAdapter>>;

export type Clock = () => number;
