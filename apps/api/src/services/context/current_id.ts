// The current request context's id, for a reader that must not load the
// context itself — the logger, which the movement engine imports and which
// must stay free of the database clients the context holds. The context module
// supplies the reader as it loads; no context module loaded means no context
// to name.

let read: () => string | undefined = () => undefined;

export function currentContextId(): string | undefined {
  return read();
}

export function readContextIdFrom(reader: () => string | undefined): void {
  read = reader;
}
