// Editor-action derivation — the activity layer's emission point (V2).
//
// The live-authoring view renders "the agent as a second cursor in the
// same editor a human drives" (principle 1). To do that it needs a small,
// SEMANTIC vocabulary of editor-actions — focus a node, settle a field
// value in, flash the completions chosen from, flag a bound credential —
// NOT the raw `executePlan(8 ops)` tool-call blobs (principle 4).
//
// We derive that vocabulary HERE, at the orchestration seam, by observing
// the tool-call stream the translation agent already publishes over
// `mq.agentUpdates`. This module subscribes for the duration of a turn,
// maps qualifying `tool_call` updates to `EditorAction`s, and re-publishes
// them on the SAME channel as new `AgentUpdate.type` values. It never
// touches the agent, its tools, the validator, or `executePlan` semantics
// — it's a pure read-and-project layer (architecture: "the view observes,
// it doesn't mutate").
//
// Why observe the stream rather than wrap tools: the agent owns its own
// tool implementations and announces each call as a `tool_call` update
// before running it (`translation_agent.ts`'s `announce`). Hooking the
// tool runner would mean editing the agent; subscribing to the stream it
// already emits keeps the agent untouched and puts the derivation cleanly
// at the orchestrator.
//
// Every reference we emit is a NAME — node paths, field names, credential
// names — exactly as they appear in the tool args (the agent works only
// in plain-language names). No UUIDs reach the view (N3-N).
//
// activity layer

import type { AgentUpdate, EditorAction } from '../openai/types';

import { mq } from '../message_queue';

/** A single executePlan operation: name-keyed, `{ kind, args }`. */
interface PlanOp {
  kind: string;
  args?: Record<string, unknown>;
}

function str(args: Record<string, unknown> | undefined, key: string): string | null {
  const v = args?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Map one `executePlan` operation to the editor-actions it represents.
 *
 * The shape mirrors what a human would see in the editor when applying the
 * same op: you focus the node, then a field settles in. Field-bearing ops
 * (`addFieldMapping`, `writeExpression`, `removeFieldMapping`) emit
 * `focusNode` + `editField`; node-shaping ops (`addRootAction`,
 * `addChildAction`, the per-node setters) emit `focusNode` only — the
 * graph re-render shows the structural change, the cursor just lands there.
 */
function actionsForPlanOp(op: PlanOp): EditorAction[] {
  const a = op.args ?? {};
  const out: EditorAction[] = [];

  switch (op.kind) {
    case 'addRootAction': {
      const nodeName = str(a, 'targetTypeName');
      if (nodeName) out.push({ type: 'focusNode', nodeName });
      break;
    }
    case 'addChildAction': {
      // The new child's node path isn't known until after the op runs;
      // the best name-keyed handle we have pre-execution is its target
      // type. Focus that — the turn-boundary refetch settles the real path.
      const nodeName = str(a, 'targetTypeName') ?? str(a, 'parentPath');
      if (nodeName) out.push({ type: 'focusNode', nodeName });
      break;
    }
    case 'addFieldMapping':
    case 'writeExpression':
    case 'removeFieldMapping': {
      const nodeName = str(a, 'nodePath');
      const fieldName = str(a, 'fieldName');
      if (nodeName) out.push({ type: 'focusNode', nodeName });
      if (nodeName && fieldName) {
        // `writeExpression` carries the finished formula; the others don't
        // (mapping added/removed without a value yet). Honest-fill: settle
        // the completed value in, or null for "this field changed".
        const value = op.kind === 'writeExpression' ? str(a, 'formula') : null;
        out.push({ type: 'editField', nodeName, fieldName, value });
      }
      break;
    }
    case 'writeSourceTraversal':
    case 'setAdapterConfig':
    case 'setNodeUniquenessConstraints':
    case 'setActionName':
    case 'setEntityEnrichment':
    case 'removeNode': {
      const nodeName = str(a, 'nodePath');
      if (nodeName) out.push({ type: 'focusNode', nodeName });
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Derive editor-actions from a single tool-call update.
 *
 * Keyed off the structured `data.args` the agent attaches to every
 * `tool_call` announce (not the prose `message`, which is for humans). The
 * arg shapes are stable per-tool and name-keyed:
 *   - `executePlan`        → operations[] fanned out into focus/editField
 *   - `getExpressionCompletions` → showCompletions (options filled by the
 *     follow-up `tool_result` if present, else an empty popover that the
 *     view shows as "looking up options at <node>")
 *   - `chooseCredential`   → bindCredential
 */
function deriveFromToolCall(args: Record<string, unknown> | undefined): EditorAction[] {
  if (!args) return [];

  // executePlan — the batch where the real authoring happens.
  if (Array.isArray((args as { operations?: unknown }).operations)) {
    const ops = (args as { operations: PlanOp[] }).operations;
    const out: EditorAction[] = [];
    for (const op of ops) {
      if (op && typeof op.kind === 'string') out.push(...actionsForPlanOp(op));
    }
    return out;
  }

  // chooseCredential — `{ name, role }`.
  const role = str(args, 'role');
  const credName = str(args, 'name');
  if (role && credName && (role === 'source' || role === 'target')) {
    return [{ type: 'bindCredential', role, name: credName }];
  }

  // getExpressionCompletions — `{ nodePath }`. The options themselves come
  // back in the tool's result, not the announce; we surface the lookup with
  // whatever the args/result carry. The `fieldName` is usually absent on
  // the completions call (it's node-scoped), so we leave it null.
  const nodePath = str(args, 'nodePath');
  const options = Array.isArray((args as { options?: unknown }).options)
    ? ((args as { options: unknown[] }).options.filter((o) => typeof o === 'string') as string[])
    : [];
  if (nodePath && options.length > 0) {
    return [{ type: 'showCompletions', nodeName: nodePath, fieldName: str(args, 'fieldName'), options }];
  }

  return [];
}

const editorActionLabel = (a: EditorAction): string => {
  switch (a.type) {
    case 'focusNode':
      return `Working on ${a.nodeName}`;
    case 'editField':
      return a.value ? `Mapping ${a.fieldName}` : `Adding ${a.fieldName}`;
    case 'showCompletions':
      return `Options at ${a.nodeName}`;
    case 'bindCredential':
      return `Connecting ${a.name}`;
  }
};

/**
 * Attach the editor-action deriver to a session's update stream for the
 * lifetime of a turn. Returns a teardown function the orchestrator calls in
 * `finally`. Idempotent teardown.
 *
 * The listener only fires on `tool_call` updates matching `sessionId`, so
 * the editor-actions we publish (which carry the editor-action types, not
 * `tool_call`) can never feed back into the deriver — no loop.
 */
export function attachEditorActionDeriver(sessionId: string): () => void {
  const onMessage = (update: AgentUpdate) => {
    if (update.sessionId !== sessionId) return;
    if (update.type !== 'tool_call') return;
    const args = (update.data as { args?: Record<string, unknown> } | undefined)?.args;
    const actions = deriveFromToolCall(args);
    for (const action of actions) {
      const editorUpdate: AgentUpdate = {
        sessionId,
        timestamp: Date.now(),
        type: action.type,
        message: editorActionLabel(action),
        data: { editorAction: action },
      };
      void mq.agentUpdates.update.publish(editorUpdate);
    }
  };

  mq.agentUpdates.update.on('message', onMessage);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    mq.agentUpdates.update.off('message', onMessage);
  };
}

// Exposed for unit tests — the pure mapping with no MQ involvement.
export const __test__ = { deriveFromToolCall, actionsForPlanOp, editorActionLabel };
