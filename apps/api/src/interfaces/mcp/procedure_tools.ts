// Bridges a flat MCP tool to an existing tRPC procedure, anywhere in the router.
// The tool's input schema is read straight off the procedure's own zod input at
// load time (no duplication, no drift), and the handler dispatches to the same
// procedure via the in-process caller. Generic across connectors — a `prefix`
// namespaces a set of configs to their router path.

import { z } from 'zod';

import type { TopLevelTool, McpToolResult } from './server';

import { trpcRouter } from '../trpc';
import { getTrpcCaller, toolHandler } from './trpc_caller';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const procedures = (trpcRouter as any)._def.procedures as Record<string, any>;

/** Unwrap a zod input (through refine/transform wrappers) to a raw object shape. */
function inputShape(path: string, arrayArg?: string): Record<string, z.ZodTypeAny> {
  const proc = procedures[path];
  if (!proc) throw new Error(`Unknown procedure: ${path}`);
  const input = proc._def.inputs?.[0];
  if (!input) return {};

  // ZodObject exposes `.shape`; ZodEffects (refine/transform) wraps `._def.schema`.
  let schema = input;
  while (schema && !schema.shape && schema._def?.schema) schema = schema._def.schema;
  if (schema?.shape) return schema.shape as Record<string, z.ZodTypeAny>;

  // Non-object input (e.g. a bare array): expose it under a single named arg.
  return { [arrayArg ?? 'input']: input as z.ZodTypeAny };
}

/** Call a procedure by dotted path via the in-process caller. */
async function callProcedure(path: string, arg: unknown): Promise<unknown> {
  const caller = getTrpcCaller();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = path.split('.').reduce<any>((obj, key) => obj?.[key], caller);
  if (typeof fn !== 'function') throw new Error(`Procedure not callable: ${path}`);
  return fn(arg);
}

interface ProcedureToolConfig {
  /** The flat tool name Claude sees (may differ from the procedure name). */
  tool: string;
  /** The procedure name, relative to the connector's `prefix`. */
  procedure: string;
  title: string;
  description: string;
  readOnly: boolean;
  /** For a procedure whose input is a bare array, the arg name to expose it under. */
  arrayArg?: string;
}

/** Build a flat MCP tool that proxies a procedure at `prefix + cfg.procedure`. */
function procedureTool(cfg: ProcedureToolConfig, prefix: string): TopLevelTool {
  const path = prefix + cfg.procedure;
  return {
    title: cfg.title,
    description: cfg.description,
    annotations: cfg.readOnly ? { readOnlyHint: true } : { destructiveHint: true },
    inputSchema: inputShape(path, cfg.arrayArg),
    handler: (args): Promise<McpToolResult> =>
      toolHandler(() => callProcedure(path, cfg.arrayArg ? args[cfg.arrayArg] : args)),
  };
}

/** Assemble a `{ toolName: TopLevelTool }` map from configs sharing a `prefix`. */
function procedureTools(
  configs: ProcedureToolConfig[],
  prefix: string,
): Record<string, TopLevelTool> {
  const map: Record<string, TopLevelTool> = {};
  for (const cfg of configs) map[cfg.tool] = procedureTool(cfg, prefix);
  return map;
}

export { procedureTool, procedureTools };
export type { ProcedureToolConfig };
