// The universal `dry_run` construction parameter — write run-mode
// derivation, pure AST (no catalog needed: `dry_run` is a platform
// argument, so construction + write-target shape is enough). Used twice:
//   - by `saveMovement`'s listener reconciliation, to derive each derived
//     trigger's dry_run⇄live run_mode from the text;
//   - by the run-now executor, to re-derive the dry-run flag from the
//     SAVED source at invocation time.
//
// Dry-run is movement-level (6_engine.md): the engine takes one dryRun
// switch per run, so the whole movement is 'dry_run' exactly when EVERY
// written-to instance was constructed `dry_run: true`. Mixed dry/live
// instances surface as 'mixed' with the offending write's span.

import {
  collectExpressionNames,
  extractHopAliases,
  expressionOfSlot,
  pathRootName,
} from 'movement-lang';
import type {
  ConstructionCall,
  MovementDeclaration,
  PathHead,
  Program,
  Span,
  Statement,
  WriteExpression,
} from 'movement-lang';

/**
 * A traversal-head alias inherits its owning instance from the head's
 * root — `slackbot-[ch:Channels …]->` makes `ch` owned by whatever owns
 * `slackbot`. Registered before the block body is walked so an
 * edge-anchored write off the alias resolves to the right instance. A
 * rootless head (`_resources`-style) leaves its aliases owner-unknown.
 *
 * A head rooted at an EXPRESSION (`AT(rows, 0)-[c:company]->`) has no name to
 * inherit from, so the owner is read off the names the expression READS: the
 * records it hands back came from those. One agreed owner is the answer; two
 * that disagree, or none that is known, leaves the aliases owner-unknown,
 * exactly as a rootless head does — this scan claims an owner only where the
 * text says one.
 */
function headOwner(
  head: PathHead,
  handleOwner: Map<string, string>,
  resolveOwner: (name: string) => string,
): string | undefined {
  const root = head.root;
  if (root === undefined) return undefined;
  if (root.kind === 'name') return resolveOwner(root.name);
  let names: Set<string>;
  try {
    names = new Set(collectExpressionNames(expressionOfSlot(root.expr)).refs);
  } catch {
    return undefined; // unparseable — the checker owns that diagnostic
  }
  const owners = new Set(
    [...names].filter((name) => handleOwner.has(name)).map((name) => resolveOwner(name)),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}

function registerHeadAliases(
  head: PathHead,
  handleOwner: Map<string, string>,
  resolveOwner: (name: string) => string,
): void {
  const owner = headOwner(head, handleOwner, resolveOwner);
  if (owner === undefined) return;
  for (const alias of extractHopAliases(head.hopsRaw)) {
    handleOwner.set(alias, owner);
  }
}

export type MovementWriteRunMode =
  | { mode: 'live' | 'dry_run' }
  | { mode: 'mixed'; span: Span };

/**
 * Which run-mode a movement's writes imply, from the AST alone.
 *
 * A write's owning instance is its target instance, or — for linked
 * writes — the instance that produced the parent handle. Writes whose
 * owner is not a `dry_run: true` construction (including `kg`, which is
 * never constructed) count as live.
 */
export function movementWriteRunMode(
  program: Program,
  movementName: string | undefined,
): MovementWriteRunMode {
  const dryInstances = new Set<string>();
  const recordConstruction = (name: string, construct: ConstructionCall): void => {
    const dryArg = construct.args.find((a) => a.name === 'dry_run');
    if (dryArg !== undefined && dryArg.value.raw.trim().toLowerCase() === 'true') {
      dryInstances.add(name);
    }
  };
  const collectConstructions = (statements: Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'assign' && statement.value.kind === 'construct') {
        recordConstruction(statement.name, statement.value.construct);
      }
    }
  };
  collectConstructions(program.statements);

  const movements = program.statements.filter(
    (s): s is MovementDeclaration => s.kind === 'movement',
  );
  const byName = new Map(movements.map((m) => [m.name, m]));
  const movement = movementName
    ? byName.get(movementName)
    : movements.length === 1
      ? movements[0]
      : undefined;
  if (!movement) return { mode: 'live' };

  const writes: Array<{ dry: boolean; span: Span }> = [];

  // Each movement body has its own alias scope. `handleOwner` maps a
  // bound name — a prior write result, or a traversal-head alias — to the
  // instance that owns it, so an edge-anchored write (`slackbot-[ch:…]->
  // { write ch-[:messages]-> … }`) is attributed to `slackbot`. A name
  // that resolves to no tracked alias is its own owner: a write rooted
  // directly on an instance name resolves to that instance.
  const walkBody = (statements: Statement[], handleOwner: Map<string, string>): void => {
    const resolveOwner = (name: string): string => handleOwner.get(name) ?? name;

    const ownerOf = (write: WriteExpression): string | undefined => {
      // A member-path root (`write m.k { … }`) is owned by no instance, as
      // the `x` of `x = m.k` then `write x { … }` is not.
      const first = write.target.kind === 'linked' ? write.target.path : write.target.kind === 'tuple' ? write.target.paths[0] : write.target;
      const root = first !== undefined ? pathRootName(first) : undefined;
      return root !== undefined ? resolveOwner(root) : undefined;
    };

    const recordWrite = (write: WriteExpression, bindingName?: string): void => {
      const owner = ownerOf(write);
      writes.push({ dry: owner !== undefined && dryInstances.has(owner), span: write.span });
      if (bindingName !== undefined && owner !== undefined) {
        handleOwner.set(bindingName, owner);
      }
    };

    for (const statement of statements) {
      switch (statement.kind) {
        case 'write':
          recordWrite(statement.write);
          break;
        case 'assign':
          if (statement.value.kind === 'write') {
            recordWrite(statement.value.write, statement.name);
          } else if (statement.value.kind === 'construct') {
            recordConstruction(statement.name, statement.value.construct);
          } else if (statement.value.kind === 'block') {
            registerHeadAliases(statement.value.block.head, handleOwner, resolveOwner);
            walkBody(statement.value.block.body, handleOwner);
          }
          break;
        case 'block':
          registerHeadAliases(statement.block.head, handleOwner, resolveOwner);
          walkBody(statement.block.body, handleOwner);
          break;
        case 'if':
          for (const arm of statement.arms) walkBody(arm.body, handleOwner);
          if (statement.elseArm) walkBody(statement.elseArm.body, handleOwner);
          break;
        case 'call': {
          // A write factored into a called movement (`Manual() { Run() }`,
          // Run holding the write) still counts. The callee has its own
          // alias scope; write-typed call arguments stay in the caller's.
          for (const arg of statement.args) {
            if (arg.kind === 'write') recordWrite(arg.write);
          }
          // Function names are case-insensitive from language version 3, and
          // two that differ only by case are refused, so folding finds the one.
          const callee = byName.get(statement.callee)
            ?? movements.find((m) => m.name.toLowerCase() === statement.callee.toLowerCase());
          if (callee !== undefined && !calling.has(callee.name)) {
            calling.add(callee.name);
            walkBody(callee.body, new Map());
            calling.delete(callee.name);
          }
          break;
        }
        default:
          break;
      }
    }
  };
  const calling = new Set<string>([movement.name]);
  walkBody(movement.body, new Map());

  if (writes.length === 0 || writes.every((w) => !w.dry)) return { mode: 'live' };
  if (writes.every((w) => w.dry)) return { mode: 'dry_run' };
  const conflicting = writes.find((w) => w.dry !== writes[0].dry);
  return { mode: 'mixed', span: (conflicting ?? writes[0]).span };
}
