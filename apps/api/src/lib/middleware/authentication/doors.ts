// Inbound doors: the auth branches core does NOT own.
//
// A webhook that authenticates by HMAC signature, or an inbound email whose
// sender decides the team, is a fact about the PRODUCT that receives it — core
// has no way to check either and no business knowing they exist (core plan §4;
// D28/D31 make the same call for the phone and address families). So the funnel
// takes a list of doors from whoever composed the process, tries them by URL
// before it tries any credential of its own, and the product implements them
// beside the adapter that reads the payload.
//
// A door resolves an IDENTITY, not a whole Principal: the acting-team gate,
// impersonation and the access level are core's tail, and running them for
// doors too is the point — a door cannot accidentally hand itself a team its
// user is not a member of.

import type { Request, Response } from 'express';
import type { ResolvedIdentity } from '../../../services/principal/core_provider';

interface InboundDoor {
  /** For diagnostics only — never parsed. */
  readonly name: string;
  /** Does this request belong to this door? Cheap; URL-shaped. */
  matches(req: Request): boolean;
  /**
   * The identity behind the credential, or `null` when the door has already
   * answered the request itself (a refused signature, an accepted no-op) and
   * the chain must stop.
   */
  authenticate(req: Request, res: Response): Promise<ResolvedIdentity | null>;
}

export { type InboundDoor };
