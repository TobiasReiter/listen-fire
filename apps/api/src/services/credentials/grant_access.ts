// Generalised per-item grants: some systems need access granted to specific
// items INSIDE an already-connected account (Sheets/Drive: the Drive picker
// under drive.file). The adapter declares its grant flow as a construction
// ACTION block; this module maps its picker action kind → the generic
// item-picker link minter, so the MCP surface stays generic while the
// adapter carries the burden.
import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import type { PickerActionKind } from './picker_spec';

import { getAdapterManifest } from '../translation_graph/adapters/registry';
import { mintItemPickerLink, type MintConnectLinkResult } from './connect_link';

const PICKER_ACTION_KINDS: readonly PickerActionKind[] = ['google-sheets-picker', 'google-drive-picker'];

export async function mintGrantAccessLink(input: {
  teamId: TeamId;
  userId: UserId;
  system: string;
  connection?: string;
}): Promise<MintConnectLinkResult | { error: string }> {
  const manifest = getAdapterManifest(input.system);
  if (!manifest) {
    return { error: `No connected system type "${input.system}" — use the names from listConnections.` };
  }
  const grantBlock = (manifest.construction ?? []).find(
    (b): b is Extract<typeof b, { kind: 'action' }> =>
      b.kind === 'action' && (PICKER_ACTION_KINDS as readonly string[]).includes(b.actionKind),
  );
  if (!grantBlock) {
    return {
      error: `${manifest.displayName ?? input.system} doesn't need per-item grants — connecting it (connectSystem) is enough.`,
    };
  }
  return mintItemPickerLink({
    teamId: input.teamId,
    userId: input.userId,
    actionKind: grantBlock.actionKind as PickerActionKind,
    ...(input.connection !== undefined ? { credentialName: input.connection } : {}),
  });
}
