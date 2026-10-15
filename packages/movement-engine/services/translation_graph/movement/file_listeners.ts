// A file's `listen` statements, read straight off the parsed program: the
// routing table every shell derives from source (the hosted product stores one
// trigger row per listen; the command line routes from them directly).

import { BridgeError, expressionOfSlot, unwrapCredentialArg } from 'movement-lang';

import type { ImportStatement, ListenDeclaration, NamedArg, Program } from 'movement-lang';

/** One `listen` statement, with its instance's construction resolved. */
export interface FileListener {
  instanceName: string;
  /** Adapter slug (the construction's callee, import-alias resolved). */
  adapter: string;
  /** Credential IMPORT name from the construction, when one was passed. */
  credentialName?: string;
  /** The construction's NON-credential args, raw as authored — the entry
   *  position rides here (`base: '"Dev Base"'`). A listen's address is
   *  relative to the instance's position, so resolving it needs these. */
  constructionArgs?: Record<string, string>;
  /** The listen's config block, statically evaluated. */
  config: Record<string, unknown>;
  movementName: string;
  /** Lane name from `listen as "…"` — becomes the trigger name when present. */
  alias?: string;
}

/**
 * Statically evaluate a listener config value. Trigger config is routing
 * data (`key: "dealflow"`), so literals are the expected shape; anything
 * the expression bridge can't reduce to a static value keeps its raw text.
 * A TYPE value (`type: <company>` — kg listens) is its bare spelling: the
 * AST already stores it unbracketed.
 */
function configValueOf(arg: NamedArg): unknown {
  if (arg.isType) return arg.value.raw.trim();
  try {
    const parsed = expressionOfSlot(arg.value);
    if (parsed.type === 'static') return parsed.value;
    if (parsed.type === 'list') {
      const elements = parsed.elements.map((e) =>
        e.type === 'static' ? e.value
        // `fields: [domains]` — bare names parse as root-less property nodes.
        : e.type === 'property' ? e.propertyTypeId
        : undefined,
      );
      if (elements.every((e) => e !== undefined)) return elements;
    }
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e;
  }
  return arg.value.raw.trim();
}

/**
 * Collect the file's `listen` statements with each listened instance
 * resolved to its construction (adapter + credential import name). Runs
 * after a clean check, so unresolvable pieces have already been reported;
 * anything still unresolvable here is skipped defensively.
 */
export function collectFileListeners(program: Program): FileListener[] {
  const importOriginals = new Map<string, string>();
  const constructions = new Map<
    string,
    { adapter: string; credentialName?: string; constructionArgs?: Record<string, string> }
  >();
  const listens: ListenDeclaration[] = [];

  const recordImports = (statement: ImportStatement): void => {
    for (const { name, alias } of statement.names) {
      if (alias !== undefined) importOriginals.set(alias, name);
    }
  };
  const original = (local: string): string => importOriginals.get(local) ?? local;

  for (const statement of program.statements) {
    if (statement.kind === 'import') {
      recordImports(statement);
    } else if (statement.kind === 'assign' && statement.value.kind === 'construct') {
      const construct = statement.value.construct;
      const credentialRaw = construct.args.find((a) => a.name === 'credentials')?.value.raw.trim();
      const credentialName = credentialRaw !== undefined ? unwrapCredentialArg(credentialRaw) : null;
      // The non-credential args, raw — the entry position a listen's address
      // is relative to.
      const constructionArgs: Record<string, string> = {};
      for (const arg of construct.args) {
        if (arg.name === 'credentials') continue;
        constructionArgs[arg.name] = arg.value.raw;
      }
      constructions.set(statement.name, {
        adapter: original(construct.callee),
        ...(credentialName !== null ? { credentialName: original(credentialName) } : {}),
        ...(Object.keys(constructionArgs).length > 0 ? { constructionArgs } : {}),
      });
    } else if (statement.kind === 'listen') {
      listens.push(statement);
    }
  }

  const listeners: FileListener[] = [];
  for (const listen of listens) {
    const config: Record<string, unknown> = {};
    for (const arg of listen.config) config[arg.name] = configValueOf(arg);
    // An inline construction (`listen to manual() {}`) is rejected by the
    // checker, so a clean program never reaches here with `listen.construct`
    // set. Every listen references a NAMED construction; anything still
    // unresolvable was reported as MOV_LISTEN_NOT_INSTANCE.
    const construction = constructions.get(listen.instance);
    if (!construction) continue;
    listeners.push({
      instanceName: listen.instance,
      adapter: construction.adapter,
      ...(construction.credentialName !== undefined
        ? { credentialName: construction.credentialName }
        : {}),
      ...(construction.constructionArgs !== undefined
        ? { constructionArgs: construction.constructionArgs }
        : {}),
      config,
      movementName: listen.movement,
      ...(listen.alias !== undefined ? { alias: listen.alias } : {}),
    });
  }
  return listeners;
}

