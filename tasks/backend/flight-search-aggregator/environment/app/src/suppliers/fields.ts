import { SupplierPayloadError } from "../errors.ts";

// Small readers for untrusted supplier JSON. Each throws SupplierPayloadError with a path.

export type Obj = Record<string, unknown>;

export function parseJson(raw: string, supplier: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new SupplierPayloadError(`${supplier}: response is not valid JSON`);
  }
}

export function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupplierPayloadError(`${path} must be an object`);
  }
  return value as Obj;
}

export function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SupplierPayloadError(`${path} must be an array`);
  return value;
}

/**
 * A list converted from XML: several children arrive as an array, a single child as a bare
 * object, and no child as a missing field.
 */
export function oneOrMany(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [obj(value, path)];
}

export function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") throw new SupplierPayloadError(`${path} must be a non-empty string`);
  return value;
}

export function int(value: unknown, path: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new SupplierPayloadError(`${path} must be an integer >= ${min}`);
  }
  return value as number;
}

/** Looks `key` up in a table built from the payload; a dangling reference is a supplier error. */
export function lookup<K, V>(table: ReadonlyMap<K, V>, key: K, path: string): V {
  const value = table.get(key);
  if (value === undefined) throw new SupplierPayloadError(`${path} refers to unknown ${JSON.stringify(key)}`);
  return value;
}
