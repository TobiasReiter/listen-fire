/**
 * The STORY VIEW — a `StoryIR` with its display vocabulary already resolved,
 * so the page that draws it never has to know a system exists.
 *
 * `storyOf` (movement-lang) is deliberately adapter-blind: it carries adapter
 * types, record types, event names and narrowing keys through as opaque
 * declared strings. Turning `attio` + `company` into "Creates a Company in
 * Attio" needs manifests, and manifests live here. So the join happens
 * server-side, once, and everything downstream — the record-graph diagram, the
 * step list — reads only what this file resolved.
 *
 * Two rules it inherits.
 *
 *   ADAPTER ENCAPSULATION. Every WORD of display comes from what an adapter
 *   declared: its manifest `displayName`, its `vocabulary.icon`, its
 *   `vocabulary.eventPhrase` templates, and the `displayName` its instance
 *   schema gives a record type. What this file adds is the composition
 *   ("<verb> <article> <record> in <system>"), which names nothing.
 *
 *   RENDER THE TRUTH. The view always carries the movement's validity, and
 *   unreadable source yields no view at all rather than a partial guess.
 *
 */

import {
  BridgeError,
  MovementParseError,
  storyOf,
  type Chip,
  type ChipPart,
  type LanguageVersion,
  type StoryFilter,
  type StoryIR,
  type StoryNode,
  type StoryShapeNode,
  type StoryTarget,
  type StoryTraversal,
  type Step,
} from 'movement-lang';
import { LRUCache } from 'lru-cache';

import type { BrandIcon } from 'movement-engine/services/translation_graph/adapter';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type {
  StoryView,
  StoryViewAction,
  StoryViewMovement,
  StoryViewRecord,
  StoryViewResult,
  StoryViewSystem,
  StoryViewTraversal,
  StoryViewTrigger,
  StoryViewType,
} from 'story-view/view';

import { getAdapterManifest, inboundAddressFor } from '../adapters/registry';
import { resolveEventPhrase } from '../vocabulary';
import { movementCatalogForTeam, type TeamMovementCatalog } from './catalog';
import {
  getMovementRow,
  listDerivedTriggerRows,
  type MovementValidityStatus,
} from './store';
import { movementSourceHash } from './version_store';

// ── The view ────────────────────────────────────────────────────────────────

// The view's SHAPE lives with the renderer that consumes it (`story-view`),
// because two mounts draw it — the workbench panel and the standalone page —
// and only one thing fills it. Type-only, so this file gains no runtime
// dependency on a React package. Re-exported so every existing reader of the
// projection keeps importing the view from the thing that produces it.
export type {
  StoryView,
  StoryViewAction,
  StoryViewHop,
  StoryViewMovement,
  StoryViewRecord,
  StoryViewResult,
  StoryViewSystem,
  StoryViewTraversal,
  StoryViewTrigger,
  StoryViewType,
} from 'story-view/view';


// ── The vocabulary the join consumes ────────────────────────────────────────

/**
 * Everything the join is allowed to know about a system, as three lookups.
 * Injecting it is what keeps the join itself adapter-blind AND testable: a
 * test supplies two unrelated shapes, so a hardcoded one cannot pass.
 */
export interface StoryVocabulary {
  /** Manifest display name + brand mark for an adapter slug. */
  system(adapterType: string): { label: string; icon: BrandIcon | null } | null;
  /** The adapter's own declared sentence for this listen config, or null when
   *  it declares none (the join then composes a generic one). */
  eventPhrase(adapterType: string, config: Record<string, unknown>): string | null;
  /** What the adapter's instance schema calls a record type, or null when it
   *  declared no separate display name (the type key is then the name). */
  recordLabel(input: { adapterType?: string; recordType: string }): string | null;
}

// ── The join ────────────────────────────────────────────────────────────────

const ACTION_VERBS: Record<StoryViewAction, string> = {
  create: 'Creates',
  update: 'Updates',
  find: 'Finds',
};

export function joinStoryView(input: {
  movement: StoryViewMovement;
  story: StoryIR;
  vocabulary: StoryVocabulary;
  /** What the platform PROVISIONED for this file's listens. Absent for a story
   *  projected from source alone — the sentence then says only what the script
   *  itself can support. */
  listeners?: StoryProvisionedListener[];
}): StoryView {
  const { story, vocabulary } = input;
  const listeners = input.listeners ?? [];

  const systemOf = (adapterType?: string): StoryViewSystem | null => {
    if (adapterType === undefined) return null;
    const found = vocabulary.system(adapterType);
    if (!found) return null;
    return { key: adapterType, label: found.label, icon: found.icon };
  };

  // A node the FILE declares is named by the author, not by a system, and the
  // address the type system knows it by is a composed path (`CallSource.file`).
  // Falling back to that address printed the path as if it were a name — which
  // is how a possessive came out as "each CallSource.file's blob". The
  // declaration's own word is the name, and it is found by COMPARING the
  // address, never by taking it apart.
  const declared = declaredNodeNames(story.shapes);

  const triggers = story.triggers.map((trigger): StoryViewTrigger => {
    const system = systemOf(trigger.adapterType);
    return {
      id: trigger.id,
      sentence: triggerSentence({
        trigger,
        system,
        vocabulary,
        provisioned: provisionedFor(trigger, listeners),
      }),
      system,
      ...(trigger.lane !== undefined ? { lane: trigger.lane } : {}),
      fires: trigger.fires,
      firesMovement: trigger.firesMovement,
    };
  });

  // A write is a write. An ask's record used to be dressed as a pause here —
  // its own verb, its own framing — but the pause is the AWAIT, and it is drawn
  // as the cut it makes across the flow. The record it raised is an ordinary
  // one, with ordinary fields, and hiding them behind "Checks with you" hid the
  // very question being asked.
  const records = story.records.map((record): StoryViewRecord => {
    const system = systemOf(record.target.adapterType);
    const label = recordLabel({ target: record.target, vocabulary, declared });
    const verb = ACTION_VERBS[record.action];
    return {
      id: record.id,
      label,
      system,
      action: record.action,
      verb,
      sentence: sentenceIn(`${verb} ${subject(label)}`, system),
      ...(record.binding !== undefined ? { binding: record.binding } : {}),
      fields: record.fields,
      fieldModes: record.fieldModes,
      uniqueBy: record.uniqueBy,
    };
  });

  const traversals = traversalsOf(story).map(
    (traversal): StoryViewTraversal => ({
      id: traversal.id,
      from: traversal.from ?? null,
      source: traversal.source,
      hops: traversal.hops.map((hop) => ({
        edge: hop.edge,
        label:
          hop.landing !== undefined
            ? recordLabel({ target: hop.landing, vocabulary, declared })
            : null,
        system: systemOf(hop.landing?.adapterType),
        ...(hop.binding !== undefined ? { binding: hop.binding } : {}),
        ...(hop.filter !== undefined ? { filter: hop.filter } : {}),
      })),
    }),
  );

  const types = referencedTargets(story).map((target): StoryViewType => ({
    adapterType: target.adapterType ?? null,
    recordType: target.recordType,
    label:
      (target.adapterType === undefined ? declared.get(target.recordType) : undefined)
      ?? vocabulary.recordLabel({
        ...(target.adapterType !== undefined ? { adapterType: target.adapterType } : {}),
        recordType: target.recordType,
      })
      ?? target.recordType,
    system: systemOf(target.adapterType),
  }));

  return {
    movement: input.movement,
    triggers,
    records,
    traversals,
    types,
    shapes: story.shapes,
    edges: story.edges,
    flow: story.flow,
  };
}

/** The author's own word for every node the file declares, by the address the
 *  type system knows it at. */
function declaredNodeNames(shapes: StoryShapeNode[]): Map<string, string> {
  const names = new Map<string, string>();
  const walk = (node: StoryShapeNode): void => {
    names.set(node.position, node.name);
    for (const child of node.children) walk(child);
  };
  for (const shape of shapes) walk(shape);
  return names;
}

/**
 * Every distinct type a reference in this story points at.
 *
 * Deliberately a walk over the flow's own shape rather than a search through
 * arbitrary objects: a chip that a new step kind carries would be silently
 * missed by a structural sweep, and a referent that resolved to nothing is
 * exactly the failure this whole redline is about. The switch below is
 * exhaustive, so a new step kind fails the build instead.
 */
function referencedTargets(story: StoryIR): Array<StoryTarget & { recordType: string }> {
  const found: Array<StoryTarget & { recordType: string }> = [];
  const seen = new Set<string>();
  const add = (target: StoryTarget): void => {
    if (target.recordType === undefined) return;
    const key = JSON.stringify([target.adapterType, target.recordType]);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ ...target, recordType: target.recordType });
  };
  const parts = (list: ChipPart[]): void => {
    for (const part of list) {
      switch (part.kind) {
        case 'reference': {
          const origin = part.reference.origin;
          if (origin?.kind === 'event' || origin?.kind === 'landing') add(origin.target);
          // A path reference is named by what its hops LAND on, so every hop
          // needs its label resolved, not just the root.
          for (const hop of part.reference.path ?? []) {
            if (hop.landing !== undefined) add(hop.landing);
          }
          break;
        }
        // A fold over a walk is named by what the walk LANDS on, exactly as a
        // for-each header is — so every hop needs its label resolved.
        case 'walk':
          for (const hop of part.traversal.hops) {
            if (hop.landing !== undefined) add(hop.landing);
          }
          break;
        // The parts nest: a condition holds its two sides, a conjunction holds
        // its operands. A sweep that only read the top level would resolve the
        // labels of everything except the references inside a test — which is
        // most of them.
        case 'test':
          parts(part.subject);
          parts(part.against);
          break;
        case 'group':
          for (const of of part.of) parts(of);
          break;
        case 'not':
          parts(part.of);
          break;
        case 'text':
        case 'expression':
          break;
      }
    }
  };
  eachChip(story, (chip) => parts(chip.parts));
  // A movement says what it TAKES, so a parameter's type needs its label
  // resolved whether or not the body ever reads the parameter.
  eachStep(story.flow, (step) => {
    if (step.kind !== 'movement') return;
    for (const param of step.params) if (param.target !== undefined) add(param.target);
  });
  return found;
}

/** Every authored expression the view carries, wherever it sits. */
function eachChip(story: StoryIR, visit: (chip: Chip) => void): void {
  const filter = (f: StoryFilter | undefined): void => {
    if (f === undefined) return;
    if (f.kind === 'expression') visit(f.chip);
    else for (const comparison of f.all) visit(comparison.value);
  };
  const node = (n: StoryNode): void => {
    for (const chip of Object.values(n.fields)) visit(chip);
    for (const child of n.children) for (const nested of child.nodes) node(nested);
  };
  for (const record of story.records) {
    for (const chip of Object.values(record.fields)) visit(chip);
    for (const chip of record.uniqueBy) visit(chip);
  }
  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      switch (step.kind) {
        case 'movement':
        // A deferred action's body is ordinary flow, and every chip in it is
        // one this view has to resolve.
        case 'callback':
          walk(step.steps);
          break;
        case 'group':
          for (const hop of step.over.hops) filter(hop.filter);
          walk(step.steps);
          break;
        case 'branch':
          for (const arm of step.arms) {
            visit(arm.condition);
            walk(arm.steps);
          }
          if (step.otherwise) walk(step.otherwise.steps);
          break;
        case 'race':
          for (const branch of step.branches) walk(branch.steps);
          break;
        case 'extract':
          for (const chip of step.from) visit(chip);
          break;
        case 'call':
          for (const arg of step.args) {
            if (arg.kind === 'value') visit(arg.chip);
            if (arg.kind === 'node') node(arg.node);
          }
          break;
        case 'node':
          node(step.node);
          break;
        case 'value':
          visit(step.value);
          break;
        // `return <value>` carries a chip when what it hands back is a plain
        // expression; an effect it returns projects as that effect instead and
        // is walked as one.
        case 'return':
          if (step.value) visit(step.value);
          break;
        case 'error':
          visit(step.message);
          break;
        case 'wait':
          if (step.wait.kind === 'until' && step.wait.condition) visit(step.wait.condition);
          break;
        case 'write':
        case 'match':
        case 'link':
        case 'unlink':
        case 'ask':
        case 'delete':
        case 'refresh':
          break;
        // A collection op's card names the collection it ran over, so that chip
        // carries referents like any other.
        case 'bind':
          if (step.over) visit(step.over);
          break;
      }
    }
  };
  walk(story.flow);
}

/**
 * What the platform made when this file went live, per `listen`. The script
 * cannot know any of it: an inbound address exists because something
 * provisioned it, and a movement that has never been saved has none.
 */
export interface StoryProvisionedListener {
  /** The channel — the source adapter slug. */
  kind: string;
  /** The movement this listener fires. */
  movementName: string | null;
  /** The listener's own routing config, as persisted. */
  config: Record<string, unknown>;
  /** Where events for this listener have to be sent (email's
   *  `<local>+<key>@<domain>`), or null for a channel with no such address. */
  inboundAddress: string | null;
}

/**
 * The listener a story trigger was provisioned as — matched on what both sides
 * actually say: the channel, the movement fired, and every narrowing key the
 * listen declared appearing with the same value in the persisted config. Two
 * listens on one channel differ by exactly those keys, so nothing else is
 * needed to tell them apart, and a listener whose config no longer agrees with
 * the script (a save that has not shipped) matches nothing rather than lending
 * its address to a listen that never had one.
 */
function provisionedFor(
  trigger: StoryIR['triggers'][number],
  listeners: StoryProvisionedListener[],
): StoryProvisionedListener | undefined {
  if (trigger.adapterType === undefined) return undefined;
  return listeners.find(
    (listener) =>
      listener.kind === trigger.adapterType
      && (listener.movementName === null || listener.movementName === trigger.fires)
      && Object.entries(trigger.narrowing).every(
        ([key, value]) => listener.config[key] === value,
      ),
  );
}

/**
 * The trigger's sentence: the adapter's own declared phrasing where it has
 * one, otherwise a generic composition from its declared display name. The
 * listen's config — its event selection plus its narrowing keys, exactly as
 * the author wrote them — is what the templates' `{slot}` tokens fill from,
 * which is the same feed a persisted trigger row gives `describeSource`.
 *
 * The PROVISIONED facts join the same slots. An email listen carries a routing
 * tag; what a person needs to be told is the address that tag mints, and only
 * the platform knows it. So it fills an `{address}` slot like any other, the
 * adapter's ordered templates decide whether saying it is the better sentence,
 * and a movement with nothing provisioned yet falls through to the phrasing
 * that is true of the script alone.
 *
 */
function triggerSentence(input: {
  trigger: StoryIR['triggers'][number];
  system: StoryViewSystem | null;
  vocabulary: StoryVocabulary;
  provisioned?: StoryProvisionedListener | undefined;
}): string {
  const { trigger, system } = input;
  const address = input.provisioned?.inboundAddress ?? null;
  const config: Record<string, unknown> = {
    ...trigger.narrowing,
    ...(trigger.events !== undefined ? { events: trigger.events } : {}),
    ...(address !== null ? { address } : {}),
  };
  const declared =
    trigger.adapterType !== undefined
      ? input.vocabulary.eventPhrase(trigger.adapterType, config)
      : null;
  if (declared !== null) return declared;

  const where = system?.label ?? trigger.instance.name;
  return `When something happens in ${where}`;
}

/**
 * What a system calls a type it landed on. A declared display name wins; where
 * the adapter declared none the KEY is the name (that is what an absent
 * `displayName` means); where nothing named a type at all there is nothing to
 * show, and null says so rather than inventing one.
 */
function recordLabel(input: {
  target: { adapterType?: string; recordType?: string };
  vocabulary: StoryVocabulary;
  /** The file's own node declarations, by address — consulted first, because a
   *  node nobody's system owns is named by the author who declared it. */
  declared: Map<string, string>;
}): string | null {
  const { recordType, adapterType } = input.target;
  if (recordType === undefined) return null;
  if (adapterType === undefined) {
    const own = input.declared.get(recordType);
    if (own !== undefined) return own;
  }
  const declared = input.vocabulary.recordLabel({
    ...(adapterType !== undefined ? { adapterType } : {}),
    recordType,
  });
  return declared ?? recordType;
}

/** Every step of the flow, nested bodies included. */
function eachStep(flow: Step[], visit: (step: Step) => void): void {
  for (const step of flow) {
    visit(step);
    switch (step.kind) {
      case 'movement':
      case 'group':
      case 'callback':
        eachStep(step.steps, visit);
        break;
      case 'branch':
        for (const arm of step.arms) eachStep(arm.steps, visit);
        if (step.otherwise) eachStep(step.otherwise.steps, visit);
        break;
      case 'race':
        for (const branch of step.branches) eachStep(branch.steps, visit);
        break;
      default:
        break;
    }
  }
}

/**
 * Every walk the story carries, wherever it was written: a block's head, and a
 * fold written over one inside an expression. Both resolve their labels the
 * same way and are looked up by the same id, because they are the same thing —
 * a walk is a walk whether the author put a block under it or wrapped it in
 * FIRST.
 *
 */
function traversalsOf(story: StoryIR): StoryTraversal[] {
  const found: StoryTraversal[] = [];
  eachStep(story.flow, (step) => {
    if (step.kind === 'group') found.push(step.over);
  });
  const parts = (list: ChipPart[]): void => {
    for (const part of list) {
      switch (part.kind) {
        case 'walk':
          found.push(part.traversal);
          break;
        case 'test':
          parts(part.subject);
          parts(part.against);
          break;
        case 'group':
          for (const of of part.of) parts(of);
          break;
        case 'not':
          parts(part.of);
          break;
        case 'text':
        case 'expression':
        case 'reference':
          break;
      }
    }
  };
  eachChip(story, (chip) => parts(chip.parts));
  return found;
}

function sentenceIn(phrase: string, system: StoryViewSystem | null): string {
  return system ? `${phrase} in ${system.label}` : phrase;
}

/**
 * A declared label goes in VERBATIM, with no article in front of it.
 *
 * The tempting version — "creates a Company" — needs a singular, and nothing
 * declares one: Attio's own vocabulary for that type is `Companies`, so an
 * article turns a declared name into "a Companies". Reshaping a declared
 * string to fit our sentence is the same mistake as parsing one. Where the
 * system named no type at all there is nothing to place, so the generic
 * stands in.
 */
function subject(label: string | null): string {
  return label ?? 'a record';
}

// ── The live vocabulary ─────────────────────────────────────────────────────

/**
 * The real lookups, over the adapter registry and the team catalog the check
 * already assembled. Record labels come from the instance schemas the catalog
 * introspected — the adapter's own `PositionSchema.displayName` where the type
 * key is not itself author-facing — so no label is invented here.
 */
export function storyVocabularyOf(teamCatalog: TeamMovementCatalog): StoryVocabulary {
  const labels = new Map<string, string>();
  const remember = (adapter: string, positions: Record<string, { displayName?: string }>): void => {
    for (const [type, position] of Object.entries(positions)) {
      if (position.displayName === undefined) continue;
      const key = `${adapter}::${type}`;
      if (!labels.has(key)) labels.set(key, position.displayName);
    }
  };
  for (const entry of teamCatalog.instanceSchemas) remember(entry.adapter, entry.schema.positions);

  return {
    system(adapterType) {
      const manifest = getAdapterManifest(adapterType);
      if (!manifest) return null;
      return { label: manifest.displayName, icon: manifest.vocabulary?.icon ?? null };
    },
    eventPhrase(adapterType, config) {
      const manifest = getAdapterManifest(adapterType);
      return manifest ? resolveEventPhrase(manifest.vocabulary?.eventPhrase, config) : null;
    },
    recordLabel({ adapterType, recordType }) {
      return labels.get(`${adapterType ?? ''}::${recordType}`) ?? null;
    },
  };
}

// ── The load ────────────────────────────────────────────────────────────────

/**
 * A saved movement's story, resolved. Loads the source and the team catalog
 * the same way the authoring path does, projects the checked program, then
 * joins. The stored validity RULING is carried in — the platform knows things
 * the checker cannot see (an adapter whose schema never came back), so
 * `unverified` survives instead of reading as clean.
 */
export async function storyViewForMovement(input: {
  teamId: string;
  id: string;
}): Promise<StoryViewResult | null> {
  const row = await getMovementRow(input);
  if (!row) return null;
  return projectStoryView(row);
}

/**
 * The projection itself, from a movement row that is already in hand.
 *
 * Both surfaces that show a story run THIS — the app's panel (through the tRPC
 * view) and the public link's page. A second implementation of "what does this
 * program do" is exactly how two pictures of one automation start disagreeing.
 */
export async function projectStoryView(row: {
  id: string;
  teamId: string;
  name: string;
  source: string;
  validityStatus: MovementValidityStatus | null;
  /** The movement's pin; absent (an unsaved preview) ⇒ the current version. */
  languageVersion?: LanguageVersion;
}): Promise<StoryViewResult> {
  // Same fallback the authoring path takes: assembling a source-scoped catalog
  // needs the source to parse, and the whole point of the unreadable branch is
  // that it may not. `types: []` describes nothing, so reporting a missing
  // bracket never loads a graph.
  let teamCatalog: TeamMovementCatalog;
  try {
    teamCatalog = await movementCatalogForTeam(row.teamId as TeamId, {
      source: row.source,
      ...(row.languageVersion !== undefined ? { languageVersion: row.languageVersion } : {}),
    });
  } catch (e) {
    if (!(e instanceof BridgeError || e instanceof MovementParseError)) throw e;
    teamCatalog = await movementCatalogForTeam(row.teamId as TeamId, { types: [] });
  }

  const result = storyOf({
    source: row.source,
    catalog: teamCatalog.catalog,
    name: row.name,
    resolveFile: teamCatalog.resolveFile,
    ...(row.validityStatus !== null ? { validityStatus: row.validityStatus } : {}),
    ...(row.languageVersion !== undefined ? { languageVersion: row.languageVersion } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: 'unreadable',
      movement: { id: row.id, name: row.name },
      problems: result.problems,
    };
  }

  return {
    ok: true,
    view: joinStoryView({
      movement: { id: row.id, name: row.name, validity: result.story.movement.validity },
      story: result.story,
      vocabulary: storyVocabularyOf(teamCatalog),
      listeners: await provisionedListeners(row.id),
    }),
  };
}

/**
 * The listeners this movement's last shipped save provisioned. A file that has
 * never gone live has none, and the trigger sentence says only what the script
 * supports — which is the honest answer, not a shortcoming to paper over.
 */
async function provisionedListeners(
  movementId: string,
): Promise<StoryProvisionedListener[]> {
  const rows = await listDerivedTriggerRows(movementId);
  return rows.map((row) => ({
    kind: row.kind,
    movementName: row.firedMovementName ?? null,
    config: row.config,
    inboundAddress: inboundAddressFor(row.kind, row.config),
  }));
}

/**
 * The same story, memoised on the program it was projected from.
 *
 * The public link projects at SERVE time — that is what keeps the page honest
 * about a movement that changed — but a link that gets opened, shared and
 * prefetched would otherwise re-run the checker and re-read every adapter
 * schema on every hit. So the key is everything about the ROW the view is
 * drawn from: any save invalidates by construction, and there is no cache
 * anybody has to remember to clear.
 *
 * The row is not the whole story, though — the vocabulary side of the join
 * reads adapter schemas, which drift without the movement changing at all.
 * A short TTL is what bounds that, and it is the one part of the page's
 * freshness the key cannot express.
 */
const servedStories = new LRUCache<string, StoryViewResult>({ max: 200, ttl: 60_000 });

export async function servedStoryView(input: {
  teamId: string;
  id: string;
}): Promise<StoryViewResult | null> {
  const row = await getMovementRow(input);
  if (!row) return null;
  const key = [
    row.id,
    row.updatedAt.getTime(),
    movementSourceHash(row.source),
    row.name,
    row.validityStatus ?? '',
    row.languageVersion,
  ].join(':');
  const hit = servedStories.get(key);
  if (hit) return hit;
  const projected = await projectStoryView(row);
  servedStories.set(key, projected);
  return projected;
}
