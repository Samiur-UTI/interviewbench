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

/** No stored search has this id (never existed, or deleted by the TTL job). Maps to HTTP 404. */
export class SearchNotFoundError extends Error {
  constructor(searchId: string) {
    super(`search not found: ${searchId}`);
    this.name = "SearchNotFoundError";
  }
}
