// A file the engine holds: a value the engine itself made, at the one place a
// file can enter a run — a field the catalog declares as a file, a typed
// resource slot, a plugin output's declared file, a parked file revived. The
// mark is a private field, which only an object this module constructs has:
// data from JSON or a webhook body can name any key, `__brand` included, and
// is never taken for a file. A spread drops the mark, as it drops a binding's
// (`binding()`), so a copy of a file's keys is data.

class FileMark {
  readonly #file = true;
  // Every instance is made by `markedFile()` around a descriptor, so holding
  // the mark IS being a file.
  static has(value: unknown): value is FileMark {
    return typeof value === 'object' && value !== null && #file in value;
  }
}

export type { FileMark };

/** A fresh marked object holding `fields`, in their order: the ONE way a file
 *  value is made (`engine-contracts` `fileValue` is the typed door to it). */
export function markedFile<T extends object>(fields: T): T & FileMark {
  return Object.assign(new FileMark(), fields);
}

/** Whether a value is a file the engine made — by the mark alone. */
export function isMarkedFile(value: unknown): value is FileMark {
  return FileMark.has(value);
}
