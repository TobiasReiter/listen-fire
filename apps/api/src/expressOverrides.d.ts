// What Listen-Fire hangs on an express Request. A DECLARATION file, and imported by
// nobody: it holds only a global augmentation, so tsc emits no JavaScript for
// it — and while it was a `.ts` that two modules imported for its side effect,
// the compiled server required a file the build had never produced.

import type { InboundEmailRoute } from 'movement-engine/public/inbound';

interface RequestOverrides {
  xRequestId: string;
  /** Where an inbound email is going, decided by the email door during
   *  authentication (it is the same question as "whose team is this?"), and
   *  read by the handler rather than asked a second time. */
  inboundEmailRoute?: InboundEmailRoute;
  /** The client TAB that issued this request — for echo suppression on
   *  the resource-change channel (a tab ignores changes it made itself). */
  xOriginId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    export interface Request extends Partial<RequestOverrides> {}
  }
}
