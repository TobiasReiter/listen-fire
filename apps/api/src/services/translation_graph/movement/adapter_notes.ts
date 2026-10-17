import type { AdapterManifest } from 'movement-engine/public/adapter';

// Plain-language notes derived from a manifest, attached to a described
// connection so an authoring agent learns a system's idiosyncrasies from the
// manifest itself — not from prose an adapter author remembered to write. Each
// enforcement fact (the credential the writes run as, the registered-actor gate)
// renders its own sentence, so a future adapter that sets the flag inherits the
// behaviour without re-typing another adapter's `triggerExpectation`.

/**
 * Who a movement over this system runs AS, and whose activity triggers it —
 * the two identity axes. Undefined for a system with neither (an intrinsic
 * like the knowledge graph, or a manual/scheduled channel).
 */
export function deriveIdentityNote(manifest: AdapterManifest): string | undefined {
  const parts: string[] = [];

  // Outbound: a credentialed system writes as the account that connected it,
  // never as whoever tripped the trigger. Intrinsics carry no credential and so
  // no runs-as line.
  if (manifest.requiredCredentialType !== undefined) {
    parts.push(
      `It runs with the ${manifest.displayName} account that connected it: whatever it writes acts as that account, not whoever set the run off.`,
    );
  }

  // Inbound: a globally-addressable channel (anyone could reach it) only fires
  // for people the team already knows. The `false`/absent case is either not an
  // inbound source or gated upstream — the system's own trigger note covers it.
  if (manifest.inboundRequiresRegisteredActor === true) {
    parts.push(
      `A listener on it fires only for activity from people set up on this team; activity from anyone else — a guest, an outside collaborator, a teammate without an account — is dropped before anything runs. So if a teammate's activity isn't triggering it, they are most likely not set up on the team yet: tell the user that rather than promising it works for everyone.`,
    );
  }

  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * What Listen-Fire can and can't do with this system, read off the methods it
 * genuinely implements plus whether it can be an event source. Undefined when
 * there is nothing limiting to say (full read/write, and it can be listened to).
 */
export function deriveCapabilityNote(manifest: AdapterManifest): string | undefined {
  // Guard the two array reads: a manifest can arrive partial (a remote install
  // parsed from an external wire, a minimally-declared adapter), and an advisory
  // note must never crash the describe path.
  const methods = manifest.methods ?? [];
  const triggers = manifest.supportedTriggers ?? [];
  const canCreate = methods.includes('createRecord');
  const canUpdate = methods.includes('updateRecord');
  const canDelete = methods.includes('deleteRecord');

  const parts: string[] = [];

  if (!canCreate && !canUpdate && !canDelete) {
    parts.push(
      `Source only: Listen-Fire reads from this and writes the result elsewhere; it isn't a place you write records back to.`,
    );
  } else if (canCreate && !canUpdate && !canDelete) {
    parts.push(`Records are added here, not updated or deleted.`);
  } else if (canCreate && canUpdate && !canDelete) {
    parts.push(`Records here can be added and updated, but not deleted.`);
  }

  if (triggers.length === 0) {
    parts.push(`It has no event triggers — use it as a write or read target, not as something to listen to.`);
  }

  return parts.length > 0 ? parts.join(' ') : undefined;
}
