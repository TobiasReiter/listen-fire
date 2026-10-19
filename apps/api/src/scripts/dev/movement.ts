/**
 * Dev-loop CLI for the movement language (M5).
 *
 *   pnpm dev:movement provision            # provision the built-in fixture
 *   pnpm dev:movement provision --file <path> [--movement <name>]
 *   pnpm dev:movement run <name> [--text "<body>"] [--file <path>]
 *                                          # invoke a saved movement's manual channel,
 *                                          # optionally carrying text and/or a file
 *   pnpm dev:movement catalog              # dump the team catalog's notes + credentials
 *   pnpm dev:movement snapshot-catalog --handbook --out <path>
 *   pnpm dev:movement snapshot-catalog --file <a.mvt> [--file <b.mvt>] --out <path>
 *   pnpm dev:movement snapshot-catalog --out <path> [--adapters a,b]
 *                                          # dump the REAL per-adapter instance
 *                                          # schemas — the movement handbook's
 *                                          # checker fixture (see its __test__).
 *                                          # `--handbook` / `--file` drive the
 *                                          # SAME demand closure a save drives;
 *                                          # bare is the legacy full-surface
 *                                          # sweep (honest only for adapters
 *                                          # that publish their whole surface).
 *
 * The built-in fixture is the M5 proof movement: an email-sourced
 * movement (mailgun plus-key routed via the file's `listen` statement)
 * writing to TWO fake-channel targets — an Attio company (the body-level
 * target) and a Slack message whose text pipes the company write-handle's
 * externalId (M4a write-handles + M4b per-write targets, through the real
 * dispatch path). The trigger row is DERIVED from the `listen` line: its
 * `key` is the mailgun plus-suffix.
 *
 * After provisioning, fire it with:
 *
 *   pnpm dev:inject mailgun-email --to <inboundAddress from the output>
 *
 * and verify with `pnpm dev:inspect attio companies` / `pnpm dev:inspect slack`.
 */

import './_profile_loader';
// Register the same service adapters the API server boots (document storage,
// email, …) so `run --file` exercises the real `services.document.upload`
// path that the on-demand invocation service uses.
import '../../services';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getQb } from '../../lib/kysely';
import { encryptToken } from '../../lib/credentials';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import {
  buildAgentContext,
  ensureDevLoopSlackCredential,
  ensureDevLoopTelegramCredential,
  ensureDevLoopTeam,
} from './_lib';
import { saveMovement } from '../../services/translation_graph/movement/provision';
import { runMovementNow } from '../../services/translation_graph/movement/run_now';
import { getMovementRowByName } from '../../services/translation_graph/movement/store';
import {
  movementCatalogForTeam,
  type TeamMovementCatalog,
} from '../../services/translation_graph/movement/catalog';
import { indexManifestsByName, listAdapterManifests } from '../../services/translation_graph/adapters/registry';

import { referencedConstructions, type InstanceSchema } from 'movement-lang';

import {
  describableAdapters,
  handbookCaptureSources,
  mergeInstanceSchemas,
  rewriteConnectionNames,
  type CaptureSource,
} from './lib/capture_catalog';

/**
 * The M5 proof fixture. Every type / field is the adapter's NATURAL name
 * (its `displayName`) — the adapter-layer resolver maps each to the internal
 * id at the boundary. These are the REAL names the live adapters publish:
 *   - `<inbox-[:Email]->>` ← the email adapter's fires edge lands STRAIGHT
 *     on `Email` (`email:message` — rule 1's collapse: the retired
 *     `Email Received` node carried no facts, so the listen delivers the
 *     email itself and `m.\`Subject\`` / `m.\`From\`` read directly off the
 *     parameter — the adapter's displayNames for `subject` / `sender`);
 *   - `crm.Companies`            ← fake Attio's companies object
 *     (displayName `Companies` from its `plural_noun`; attribute titles
 *     `Name` / `Description`);
 *   - `chat-[ch:Channels WHERE \`Name\` == "..."]-> { write ch-[:Messages]-> … }`
 *     ← Slack's unified `Message` type, created along the channel's
 *     `messages` edge (displayName `Message`; field `Message`). Its
 *     fires edge lands straight on the message too (rule 1's collapse), so
 *     `dealflow_reply` takes `<chat-[:Message]->>` and replies
 *     along the PARAMETER's own `replies` edge;
 *   - credentials `` `Dev Loop Attio` `` / `` `Dev Loop Slack` `` — credentials
 *     are imported by their NAME (backticked when it carries spaces).
 */
const FIXTURE_MOVEMENT_NAME = 'dealflow_intake';
const FIXTURE_MOVEMENT = `
import { email, attio, slack } from adapters
import { \`Dev Loop Attio\`, \`Dev Loop Slack\` } from credentials

inbox = connect email
crm   = connect attio using \`Dev Loop Attio\`
chat  = connect slack using \`Dev Loop Slack\`

function dealflow_intake(m: <inbox-[:Email]->>) {
  co = write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: "Introduced by \${m.\`From\`}"
  }
  chat-[ch:Channels WHERE ch.\`Name\` == "dealflow"]-> {
    write ch-[:Messages]-> {
      Message: "New company in Attio: \${m.\`Subject\`} (record \${co.externalId})"
    }
  }
}

listen to inbox { key: "dealflow-intake" } fire dealflow_intake

function dealflow_reply(sm: <chat-[:Message]->>) {
  write sm-[:Replies]-> {
    Message: "Noted: \${sm.\`Message\`}"
    File: File.from("Summary of: \${sm.\`Message\`}", "text")
  }
}

listen to chat { events: ["message"] } fire dealflow_reply
`;


function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Every occurrence of a repeatable flag, in order (`--file a --file b`). */
function argValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((arg, i) => {
    if (arg !== flag) return;
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith('--')) out.push(value);
  });
  return out;
}

/** The adapters the handbook's fixture has always carried, when nothing narrows it. */
const DEFAULT_SNAPSHOT_ADAPTERS = ['email', 'attio', 'slack', 'manual', 'cron'];

interface CapturedCatalog {
  schemas: Record<string, InstanceSchema>;
  specs: Record<string, unknown>;
  notes: string[];
  /** Which constructed names this workspace could have described at all. */
  describable: (constructed: Iterable<string>) => string[];
}

/** The adapter SPEC (construction signature + the `listen { … }` config
 *  vocabulary) is as much a part of what an example must be true about as the
 *  instance schema — `listen to timer { schedule: … }` is checked against it —
 *  so both are captured. Construction-free, hence read off any catalog. */
function specOf(catalog: TeamMovementCatalog['catalog'], adapter: string): unknown {
  const { schema: _bundled, ...spec } = (catalog.adapter(adapter) ?? {}) as Record<
    string,
    unknown
  >;
  return spec;
}

/**
 * DEMAND-SCOPED capture — the fixture path.
 *
 * One `movementCatalogForTeam({ source })` per demand source: the very call
 * `saveMovement` makes, so the capture describes what a save would describe
 * (demand seed, chain closure, event narrowing, WHERE refinements,
 * construction-site landings) and nothing else. A container-shaped adapter is
 * captured for the same reason a save can type one — the movement NAMES a
 * container, so its path is demanded — where the full-surface sweep is refused
 * outright and captures nothing at all.
 *
 * The union over the demand set is the fixture: each source contributes what it
 * needed, and `mergeInstanceSchemas` keeps a described position over an
 * undescribed one.
 */
async function captureByDemand(input: {
  teamId: TeamId;
  sources: CaptureSource[];
  adapters?: string[];
}): Promise<CapturedCatalog> {
  // One describe-free build for the workspace's own facts: which connections
  // exist, under the names `instantiate` resolves. `types: []` is the
  // documented "skeleton" scoping — the entry lists come back, nothing is
  // described.
  const skeleton = await movementCatalogForTeam(input.teamId, { types: [] });
  const connectionByAdapter = new Map<string, string>();
  for (const name of Object.keys(skeleton.credentialsByName).sort()) {
    for (const adapter of skeleton.credentialsByName[name]?.adapters ?? []) {
      if (!connectionByAdapter.has(adapter)) connectionByAdapter.set(adapter, name);
    }
  }

  const schemas: Record<string, InstanceSchema> = {};
  const notes: string[] = [];
  for (const [index, entry] of input.sources.entries()) {
    const { source, unresolved } = rewriteConnectionNames({
      source: entry.source,
      connectionForAdapter: (adapter) => connectionByAdapter.get(adapter),
    });
    for (const miss of unresolved) {
      notes.push(
        `${entry.label}: no ${miss.adapter} connection on this team (authored '${miss.authored}') — instance untyped`,
      );
    }
    try {
      const built = await movementCatalogForTeam(input.teamId, { source });
      for (const instance of built.instanceSchemas) {
        if (input.adapters && !input.adapters.includes(instance.adapter)) continue;
        // The fixture is keyed by ADAPTER, so it can only carry the default
        // (meta) position's surface — a positioned instance is a different node
        // and writing it under the adapter's key would assert leaves the meta
        // node doesn't have.
        if (instance.positionKey !== '') {
          notes.push(
            `${entry.label}: ${instance.adapter} is constructed at an entry position — not representable in an adapter-keyed fixture, skipped`,
          );
          continue;
        }
        schemas[instance.adapter] = mergeInstanceSchemas(
          schemas[instance.adapter],
          instance.schema,
        );
      }
      for (const gap of built.gaps) {
        notes.push(`${entry.label}: ${gap.adapter} — ${gap.detail}`);
      }
    } catch (err) {
      notes.push(
        `${entry.label}: catalog build failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    console.error(`[${index + 1}/${input.sources.length}] ${entry.label}`);
  }

  const specs: Record<string, unknown> = {};
  for (const adapter of Object.keys(schemas)) {
    specs[adapter] = specOf(skeleton.catalog, adapter);
  }
  for (const adapter of DEFAULT_SNAPSHOT_ADAPTERS) {
    if (schemas[adapter] === undefined) {
      notes.push(`${adapter}: nothing in the demand set constructs it — absent from this capture`);
    }
  }
  const manifests = indexManifestsByName(listAdapterManifests());
  return {
    schemas,
    specs,
    notes,
    describable: (constructed) =>
      describableAdapters({
        constructed,
        requiresConnection: (adapter) => {
          const manifest = manifests.get(adapter);
          return manifest === undefined ? undefined : Boolean(manifest.requiredCredentialType);
        },
        hasConnection: (adapter) => connectionByAdapter.has(adapter),
      }),
  };
}

/**
 * The legacy FULL-SURFACE sweep, kept for adapters that publish their whole
 * surface (email, slack, manual, cron, ask). It is a lie for a container-shaped
 * one: `cachedAdapterInstance` refuses a full-surface describe there — walking
 * every container is the fan-out the walk model exists to kill — so every
 * position comes back `undescribed` and the capture asserts nothing.
 */
async function captureFullSurface(input: {
  teamId: TeamId;
  adapters: string[];
}): Promise<CapturedCatalog> {
  const { catalog } = await movementCatalogForTeam(input.teamId);
  const credentialFor: Record<string, string> = {
    attio: 'Dev Loop Attio',
    slack: 'Dev Loop Slack',
  };
  const schemas: Record<string, InstanceSchema> = {};
  const specs: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const adapter of input.adapters) {
    const credential = credentialFor[adapter];
    const schema = catalog.instantiate(
      adapter,
      credential !== undefined ? { credentials: credential } : {},
    );
    if (schema === undefined) {
      notes.push(`${adapter}: no schema (adapter unreachable or uncredentialed)`);
      continue;
    }
    schemas[adapter] = schema;
    specs[adapter] = specOf(catalog, adapter);
  }
  return { schemas, specs, notes, describable: (constructed) => [...new Set(constructed)] };
}

/** Best-effort content type from a file extension — enough for the dev loop's
 *  text/pdf/image fixtures; defaults to octet-stream. */
function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const byExt: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  return byExt[ext] ?? 'application/octet-stream';
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'provision';

  const seed = await ensureDevLoopTeam();
  await ensureDevLoopSlackCredential(seed.teamId);
  // The handbook's examples construct Telegram, and only `dev:telegram setup`
  // otherwise creates its credential — without it the capture silently drops
  // the system.
  if (command === 'snapshot-catalog') await ensureDevLoopTelegramCredential(seed.teamId);

  if (command === 'catalog') {
    const catalog = await movementCatalogForTeam(seed.teamId as TeamId);
    console.log(
      JSON.stringify(
        { credentialsByName: catalog.credentialsByName, notes: catalog.notes },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'snapshot-catalog') {
    // Dump the REAL instance schemas the dev-loop team's adapters publish, as
    // the movement handbook's checker fixture. The handbook's examples are
    // validated against THIS — so an example can only pass by being true about
    // what the adapters actually publish, and re-running this command after an
    // adapter changes shape fails every example the change invalidated.
    // Hand-written fixtures cannot make that promise: the retired
    // `Email Received` node and `e-[m:record]->` hop survived 87 occurrences
    // precisely because nothing compared them to reality.
    //
    // WHAT gets described is demand-scoped when the capture is given movement
    // sources (`--handbook` / `--file`), because that is how a real save works
    // — see `captureByDemand`.
    const adapters = argValue(args, '--adapters')
      ?.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const sources: CaptureSource[] = [
      ...(args.includes('--handbook') ? handbookCaptureSources() : []),
      ...argValues(args, '--file').map((file) => ({
        label: file,
        source: fs.readFileSync(path.resolve(file), 'utf-8'),
      })),
    ];
    const captured =
      sources.length > 0
        ? await captureByDemand({
            teamId: seed.teamId as TeamId,
            sources,
            ...(adapters !== undefined ? { adapters } : {}),
          })
        : await captureFullSurface({
            teamId: seed.teamId as TeamId,
            adapters: adapters ?? DEFAULT_SNAPSHOT_ADAPTERS,
          });
    for (const note of captured.notes) console.error(`! ${note}`);
    if (args.includes('--handbook')) {
      // A capture missing an adapter the examples construct would write a
      // fixture that quietly checks those examples against nothing.
      const absent = captured
        .describable(sources.flatMap((s) => referencedConstructions(s.source).map((r) => r.adapter)))
        .filter((adapter) => captured.schemas[adapter] === undefined)
        .sort();
      if (absent.length > 0) {
        console.error(
          `snapshot-catalog --handbook: the handbook's examples construct ${absent.join(', ')}, but the capture has no schema for ${absent.length === 1 ? 'it' : 'them'} — see the notes above. Not writing the fixture.`,
        );
        process.exit(1);
      }
    }
    const out = argValue(args, '--out');
    const json = `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        // How this capture was scoped — a full-surface sweep and a demand
        // closure are different claims about the same adapters, and a reader
        // of the fixture has to be able to tell which one they are holding.
        capturedFrom:
          sources.length > 0
            ? { mode: 'demand' as const, sources: sources.length }
            : { mode: 'full-surface' as const },
        specs: captured.specs,
        schemas: captured.schemas,
      },
      null,
      2,
    )}\n`;
    if (out !== undefined) {
      fs.writeFileSync(path.resolve(out), json);
      console.log(`wrote ${Object.keys(captured.schemas).length} schemas to ${out}`);
    } else {
      process.stdout.write(json);
    }
    return;
  }

  if (command === 'run') {
    // Inject an invocation event on the saved movement's MANUAL channel
    // (`go = manual()` + `listen to go {} fire <movement>`) — the same
    // dispatch path the editor's "Run now" button uses (movement.runNow).
    const name = args[1];
    if (!name) {
      console.error('Usage: pnpm dev:movement run <movement-name>');
      process.exit(1);
    }
    const row = await getMovementRowByName({ teamId: seed.teamId, name });
    if (!row) {
      console.error(`No movement named '${name}' on the dev-loop team`);
      process.exit(1);
    }
    // Optional run input: --text "<body>" and/or --file <path> (read +
    // base64-encoded) exercise the manual invocation's text + file resources.
    const text = argValue(args, '--text');
    const filePath = argValue(args, '--file');
    const files = filePath
      ? [
          {
            filename: path.basename(filePath),
            contentType: mimeTypeForPath(filePath),
            contentBase64: fs.readFileSync(path.resolve(filePath)).toString('base64'),
          },
        ]
      : undefined;
    // The in-process dispatch (and the services it reaches — RawTextService,
    // the movement-issue alerter, …) read the ambient AsyncLocalStorage
    // Context; calling `runMovementNow` bare leaves plugin persistence throwing
    // "Async local storage undefined". Mirror the live path's team context.
    const result = await buildAgentContext(seed.teamId, seed.userId).runAsync(() =>
      runMovementNow({
        teamId: seed.teamId,
        movementId: row.id,
        ...(text !== undefined ? { text } : {}),
        ...(files !== undefined ? { files } : {}),
        actor: { email: 'dev-loop@example.com', name: 'Dev Loop' },
      }),
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (command !== 'provision') {
    console.error(
      `Unknown command '${command}'. Use: provision | run | catalog | snapshot-catalog`,
    );
    process.exit(1);
  }

  const file = argValue(args, '--file');
  const source = file
    ? fs.readFileSync(path.resolve(file), 'utf-8')
    : FIXTURE_MOVEMENT;

  const movementName = argValue(args, '--movement');
  // The demo seed runs on every `up.sh --demo`, including on an installation
  // upgraded from an older language version. Re-saving the fixture would
  // rewrite that automation in the current spelling against its old pin
  // (invalid), and would overwrite a self-hoster's own edits. An existing
  // demo automation stays as it is; moving it forward is the product's
  // explicit upgrade.
  if (file === undefined && movementName === undefined) {
    const existing = await getMovementRowByName({ teamId: seed.teamId, name: FIXTURE_MOVEMENT_NAME });
    if (existing) {
      console.log(
        `'${FIXTURE_MOVEMENT_NAME}' already exists (language version ${existing.languageVersion}); left untouched.`,
      );
      return;
    }
  }
  // saveMovement: the canonical `automations.movement` row is written first,
  // then gated + the file's listeners reconciled — same path the editor
  // uses. The inbound key now lives in the file's `listen` config.
  const result = await saveMovement({
    teamId: seed.teamId,
    source,
    ...(movementName !== undefined ? { name: movementName } : {}),
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
