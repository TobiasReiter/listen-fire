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
 *  value is made (`engine-contracts` `fileValue` is the typed door to it).
 *  Written out as JSON, it is its opaque view (`fileView`), never its
 *  descriptor: whatever writes a file into text — a prompt, a trace, a CRM
 *  field — writes no host internals. */
export function markedFile<T extends object>(fields: T): T & FileMark {
  const file = Object.assign(new FileMark(), fields);
  Object.defineProperty(file, 'toJSON', { value: () => fileView(file), enumerable: false });
  return file;
}

/**
 * What a reader sees of a file, on both engines: its `name`, `contentType`
 * and `size`, and its `handle` — the opaque identity string (the owner's
 * handle, or the store key), compared and carried, never read inside. Its
 * source, credential, construction args and URL are not part of it: a read of
 * any of them off a file is absent.
 */
export function fileView(file: object): { name?: string; contentType?: string; size?: number; handle?: string } {
  const member = (key: string): unknown => Reflect.get(file, key);
  const name = member('name');
  const contentType = member('contentType');
  const size = member('size');
  const source = member('source');
  const handle =
    typeof source === 'object' && source !== null
      ? Reflect.get(source, Object.hasOwn(source, 'store') ? 'objectUri' : 'handle')
      : undefined;
  return {
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof contentType === 'string' ? { contentType } : {}),
    ...(typeof size === 'number' ? { size } : {}),
    ...(typeof handle === 'string' ? { handle } : {}),
  };
}

/** Whether a value is a file the engine made — by the mark alone. */
export function isMarkedFile(value: unknown): value is FileMark {
  return FileMark.has(value);
}
