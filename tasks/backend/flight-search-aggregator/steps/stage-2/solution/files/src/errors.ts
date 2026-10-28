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

type StatusLike = { supplier: string; status: string; error?: string };

/** Every supplier failed or timed out: we couldn't ask anyone (not "there are no flights"). */
export class NoSuppliersAvailableError extends Error {
  readonly suppliers: readonly StatusLike[];

  constructor(suppliers: readonly StatusLike[]) {
    super(`no supplier answered: ${suppliers.map((s) => `${s.supplier} ${s.status}`).join(", ")}`);
    this.name = "NoSuppliersAvailableError";
    this.suppliers = suppliers;
  }
}
