// Tunables shared by the server and the browser bundle. Times are milliseconds.
export const config = {
  connectivity: {
    /**
     * How often the server checks every connection (one shared schedule, however many dashboards
     * are open; the first round starts when the server starts listening).
     */
    probeIntervalMs: 60_000,
    /** Spacing between the checks that confirm a failure (README, "Connectivity"). */
    confirmIntervalMs: 2_000,
    /** Consecutive failed checks before a connection is shown as Disconnected. */
    confirmAttempts: 3,
  },
  breaker: {
    /**
     * Consecutive unreachable/rate_limited platform calls on one connection that open its circuit.
     * `unauthorized` never trips it: a rejected credential is not an outage.
     */
    failureThreshold: 5,
    /** How long an open circuit short-circuits calls before letting one through again. */
    openMs: 60_000,
  },
  retry: {
    /** Campaign sends: total attempts per item, exponential backoff with full jitter. */
    attempts: 4,
    baseMs: 500,
    maxMs: 8_000,
  },
  tokens: {
    /** Refresh an OAuth access token this long before its expiresAt. */
    refreshMarginMs: 60_000,
  },
  dashboard: {
    /**
     * Newest events per run in the page, `/api/dashboard` and WebSocket snapshots. Older ones are
     * fetched on demand (GET /api/runs/:id/events).
     */
    recentEvents: 20,
  },
};

export type Config = typeof config;
export type ConnectivityConfig = Config["connectivity"];
export type BreakerConfig = Config["breaker"];
export type RetryConfig = Config["retry"];
export type TokenConfig = Config["tokens"];
export type DashboardConfig = Config["dashboard"];
