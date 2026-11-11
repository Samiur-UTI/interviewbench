// Credentials ready to put on the wire. For oauth connections that means an access token that
// won't expire mid-request: refreshes happen here and only here, so concurrent callers share one
// refresh (Google rate-limits bursts on its token endpoint and may revoke the grant).
import { NotFoundError, PlatformError } from "./errors.ts";
import type { PlatformRegistry } from "./platforms/types.ts";
import type { Store } from "./store.ts";
import type { TokenConfig } from "../shared/config.ts";
import type { Scheduler } from "../shared/scheduler.ts";
import type { Connection, Credential, OAuthCredential } from "../shared/types.ts";

export interface FreshOptions {
  /** Refresh even if the cached token looks valid (the platform just rejected it). */
  force?: boolean;
}

export class TokenCache {
  private readonly cache = new Map<string, Credential>();
  private readonly refreshing = new Map<string, Promise<Credential>>();
  private readonly store: Store;
  private readonly platforms: PlatformRegistry;
  private readonly scheduler: Scheduler;
  private readonly config: TokenConfig;

  constructor(store: Store, platforms: PlatformRegistry, scheduler: Scheduler, config: TokenConfig) {
    this.store = store;
    this.platforms = platforms;
    this.scheduler = scheduler;
    this.config = config;
  }

  /**
   * The credential last returned by getFresh for this connection, exactly as cached: no expiry
   * check, no refresh, no platform call. undefined until getFresh has run for the connection (and
   * again after invalidate). The token in it may have expired since; use getFresh for anything
   * that is sent to a platform.
   */
  peek(connectionId: string): Credential | undefined {
    return this.cache.get(connectionId);
  }

  /**
   * A credential that is safe to send now. For oauth connections, refreshes the access token when
   * it expires within `refreshMarginMs` (or when `force` is set), stores the refreshed credential
   * and caches it; concurrent callers share a single refresh. Other methods are returned as stored.
   *
   * Throws NotFoundError for an unknown connection and PlatformError when the refresh fails
   * (`unauthorized` when the refresh token is dead).
   */
  async getFresh(connectionId: string, options: FreshOptions = {}): Promise<Credential> {
    const connection = this.store.getConnection(connectionId);
    if (!connection) throw new NotFoundError("connection", connectionId);
    const credential = this.cache.get(connectionId) ?? connection.credential;
    if (connection.method !== "oauth") {
      this.cache.set(connectionId, credential);
      return credential;
    }
    const { expiresAt } = credential as OAuthCredential;
    if (!options.force && expiresAt - this.config.refreshMarginMs > this.scheduler.now()) {
      this.cache.set(connectionId, credential);
      return credential;
    }
    return this.refresh(connection, credential);
  }

  /** Forgets the cached credential (after a reconnect stored a new one, for example). */
  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
    this.refreshing.delete(connectionId);
  }

  private refresh(connection: Connection, credential: Credential): Promise<Credential> {
    const pending = this.refreshing.get(connection.id);
    if (pending) return pending;
    const adapter = this.platforms[connection.platform];
    if (!adapter?.refresh) {
      return Promise.reject(new PlatformError("unauthorized", `${connection.platform}: token expired and cannot be refreshed`));
    }
    const refresh = adapter.refresh(credential).then(
      (fresh) => {
        if (this.refreshing.get(connection.id) === refresh) {
          this.refreshing.delete(connection.id);
          this.cache.set(connection.id, fresh);
          this.store.updateConnection(connection.id, { credential: fresh });
        }
        return fresh;
      },
      (error: unknown) => {
        if (this.refreshing.get(connection.id) === refresh) this.refreshing.delete(connection.id);
        throw error;
      },
    );
    this.refreshing.set(connection.id, refresh);
    return refresh;
  }
}
