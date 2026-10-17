// What an adapter is: its manifest, the live instance a run calls, the
// awaitable capability, the dry-run wrapper, and the type name rules.

export * from '../services/translation_graph/adapter';
export { normalizeAdapterType } from '../services/translation_graph/adapter_type';
export * from '../services/translation_graph/awaitable';
export {
  newDryRunRehearsal,
  wrapAdapterForDryRun,
  type CapturedWrite,
  type DryRunRehearsal,
  type DryRunWriteSink,
} from '../services/translation_graph/engine/dry_run_adapter';
export * from '../services/translation_graph/mutation_context';
export {
  ADAPTER_TEAM_HEADER,
  RemoteProtocolError,
  RemoteResponseShapeError,
  RemoteTransportError,
  authHeader,
  parseWireResult,
  postRpc,
  type AuthStrategy,
} from '../services/translation_graph/protocol/client';
