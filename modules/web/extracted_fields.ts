// The extracted context, read as fields — shared by the two person plugins.
//
// `extractedContext` is opaque at the registry boundary (see `./registry`), so
// every plugin that reads it has to answer the same three questions: which
// values belong to the record the stage sits behind, which belong to an
// ancestor the engine nested under its node name, and how a value that was
// annotated `{ label, value }` differs from a bare one. One answer, because
// two plugins disagreeing about whose company name they are looking at is a
// bug neither of them can see.

/** `key` is the name the field sits under in the extracted context, which is
 *  what a plugin's own fields are recognised by; `label` is what a model is
 *  shown, and an annotated field may carry a prettier one. */
export type ResolvedField = { key: string; label: string; value: string };

/** The record's own extracted fields, plus any ancestor context the engine
 *  nested under the ancestor node's name (e.g. `company`). Keeping the two
 *  apart is what lets a person plugin focus on the person, so verbose company
 *  prose can't crowd out their name. */
export interface PersonContext {
  own: ResolvedField[];
  ancestors: Array<{ label: string; fields: ResolvedField[] }>;
}

/** A nested ancestor context is a plain object that is NOT a `{ label, value }`
 *  wrapper: the engine threads ancestor fields as `{ company: { … } }`, while
 *  an annotated own field is `{ label, value }` and a scalar own field is a
 *  primitive. */
function isAncestorContext(raw: unknown): raw is Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw) && !('value' in raw);
}

/** Resolve one own field — a scalar or an annotated `{ label, value }` — to a
 *  `{ label, value }` pair, or null when it carries no usable value. */
export function resolveOwnField(key: string, raw: unknown): ResolvedField | null {
  if (raw && typeof raw === 'object' && 'value' in (raw as object)) {
    const wrapped = raw as { label?: unknown; value?: unknown };
    const label = typeof wrapped.label === 'string' ? wrapped.label : key;
    if (wrapped.value != null && String(wrapped.value).trim()) {
      return { key, label, value: String(wrapped.value) };
    }
    return null;
  }
  if (raw != null && String(raw).trim()) return { key, label: key, value: String(raw) };
  return null;
}

/** Resolve a flat record (or a legacy `{ label, value }` array) into a field
 *  list — used for an ancestor's nested fields and the array shape. */
export function resolveFieldList(source: unknown): ResolvedField[] {
  const out: ResolvedField[] = [];
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (entry && typeof entry === 'object') {
        const e = entry as { label?: unknown; value?: unknown };
        if (typeof e.label === 'string' && e.value != null && String(e.value).trim()) {
          out.push({ key: e.label, label: e.label, value: String(e.value) });
        }
      }
    }
    return out;
  }
  if (source && typeof source === 'object') {
    for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
      const field = resolveOwnField(key, raw);
      if (field) out.push(field);
    }
  }
  return out;
}

/**
 * Split the opaque `extractedContext` into the record's own fields and any
 * ancestor context nested under a node name. Own fields accept the shapes the
 * engine and the legacy pipeline both produce (flat records, annotated
 * `{ label, value }`, arrays); a nested plain object is an ancestor context.
 */
export function resolvePersonContext(extractedContext: unknown): PersonContext {
  const own: ResolvedField[] = [];
  const ancestors: Array<{ label: string; fields: ResolvedField[] }> = [];
  if (extractedContext == null) return { own, ancestors };

  if (Array.isArray(extractedContext)) {
    return { own: resolveFieldList(extractedContext), ancestors };
  }
  if (typeof extractedContext !== 'object') return { own, ancestors };

  for (const [key, raw] of Object.entries(extractedContext as Record<string, unknown>)) {
    if (isAncestorContext(raw)) {
      const fields = resolveFieldList(raw);
      if (fields.length > 0) ancestors.push({ label: key, fields });
      continue;
    }
    const field = resolveOwnField(key, raw);
    if (field) own.push(field);
  }
  return { own, ancestors };
}
