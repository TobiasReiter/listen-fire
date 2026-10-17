// Shared helpers for the id-based-write NOT-FOUND contract (3b).
//
// An `updateRecord` is a write BY id; when the target record is gone, the
// adapter must report it through the typed `UpdateNotFound` signal rather than
// throwing an opaque error, so the engine's bind self-heal can re-mint. Each
// adapter maps ITS OWN system's not-found into the signal — this module only
// supplies the common shapes (HTTP-404 detection, the signal constructor) so
// every adapter spells it the same way.

import type { UpdateNotFound } from 'movement-engine/public/adapter';

/** The typed not-found signal an `updateRecord` returns when its target is
 *  gone. One constant so every adapter returns the identical shape. */
export const UPDATE_NOT_FOUND: UpdateNotFound = { notFound: true };

/**
 * Whether a thrown error represents an HTTP 404 (the record does not exist).
 * Several adapters' HTTP clients throw a plain `Error` whose message carries
 * the status code; this is the one place that pattern is interpreted, so the
 * detection stays consistent and legible across adapters. Adapters whose
 * clients throw a typed/status-bearing error should test that field directly
 * instead of relying on the message.
 */
export function isHttp404(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Match a 404 as a standalone token, not as a substring of another number.
  return /\b404\b/.test(error.message);
}
