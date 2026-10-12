// A value on the eval wire (crates/movement-engine/src/env.rs says the
// format) as the oracles write it: every object and list under id 0 (the
// Rust harness drops ids), a file as its opaque handle, a text holding a
// lone surrogate as its code units.

import { fileHandle, isFileValue } from '../../../../packages/engine-contracts/file_ref';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A text: itself, or `["s16", units]` when it holds a lone surrogate. */
export function wireText(text: string): unknown {
  if (!LONE_SURROGATE.test(text)) return text;
  return ['s16', Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))];
}

export function wire(value: unknown): unknown {
  if (value === undefined) return ['u'];
  if (typeof value === 'string') return wireText(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['n', 'NaN'];
    if (value === Infinity) return ['n', 'Infinity'];
    if (value === -Infinity) return ['n', '-Infinity'];
    if (Object.is(value, -0)) return ['n', '-0'];
    return value;
  }
  if (Array.isArray(value)) return ['l', 0, value.map(wire)];
  // A file crosses as the eval wire carries it: an opaque handle (id, identity,
  // what it may print), its descriptor staying host-side.
  if (isFileValue(value)) {
    const handle = fileHandle(value);
    return ['F', 0, { ...(handle !== undefined ? { handle } : {}), ...(value.name !== undefined ? { name: value.name } : {}), ...(value.size !== undefined ? { size: value.size } : {}) }];
  }
  if (value !== null && typeof value === 'object') {
    return ['o', 0, Object.entries(value).map(([k, v]) => [wireText(k), wire(v)])];
  }
  return value;
}

/** What running it did: its value on the wire, or what it threw. */
export function outcome(run: () => unknown): unknown {
  try {
    return { value: wire(run()) };
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    return { throws: { name: e.name, message: e.message } };
  }
}
