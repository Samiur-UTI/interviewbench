/** The caller sent something we can't search for. Maps to HTTP 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** A supplier response we can't read. The whole payload is rejected, never guessed at. */
export class SupplierPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierPayloadError";
  }
}
