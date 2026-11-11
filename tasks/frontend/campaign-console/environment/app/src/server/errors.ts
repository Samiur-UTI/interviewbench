import type { ProbeCause } from "../shared/types.ts";

export type PlatformErrorCause = Exclude<ProbeCause, "circuit_open">;

/**
 * A platform call failed. `cause` is what we do about it: `unauthorized` (the credential was
 * rejected), `unreachable` (network, timeout, 5xx) or `rate_limited` (429 and friends).
 * Adapters put whatever helps support in `details` (the request, the platform's error body).
 */
export class PlatformError extends Error {
  override readonly cause: PlatformErrorCause;
  readonly details: unknown;

  constructor(cause: PlatformErrorCause, message: string, details?: unknown) {
    super(message);
    this.name = "PlatformError";
    this.cause = cause;
    this.details = details;
  }
}

export class NotFoundError extends Error {
  readonly kind: string;
  readonly id: string;

  constructor(kind: string, id: string) {
    super(`${kind} ${id} not found`);
    this.name = "NotFoundError";
    this.kind = kind;
    this.id = id;
  }
}

export class ValidationError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}
