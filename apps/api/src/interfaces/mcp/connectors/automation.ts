// The automations MCP connector, as it was mounted inline in server.ts.
// Moved here so a deployment that does not run automations does not serve it
// (D30(d)); the definition itself is unchanged.

import { Router } from 'express';
import { z } from 'zod';

import { createMcpRouter, type McpRouterOptions } from '../server';
import { storyApp } from '../story_app';
import { AUTOMATION_MCP_PATH } from '../paths';
import {
  whatsappLinkVerification,
  type WhatsappLinkVerification,
} from '../../../services/whatsapp/phone_verification/link_verification';
import { LANGUAGE_SEARCH_KINDS } from '../../../lib/knowledge/movement_handbook/language_search';

// The two WhatsApp linking tools describe the flow THIS deployment runs, so an
// agent on a trusting deployment is never told to ask the user for a code.
const WHATSAPP_LINK_DESCRIPTION: Record<WhatsappLinkVerification, string> = {
  otp: "Link the user's WhatsApp number so messages they send to the Listen-Fire WhatsApp number run their automations. Sends a one-time verification code to the number over WhatsApp. Pass the number in full international format (e.g. +447700900000). Returns instructions: ask the user for the code they received on WhatsApp, then call confirmWhatsappCode with the same number and that code. A number must be linked this way before a WhatsApp listener will fire for that person — an unverified number is ignored. If the number is already linked to a different account, or a code was just sent, the call returns a clear reason.",
  trust:
    "Link the user's WhatsApp number so messages they send to the Listen-Fire WhatsApp number run their automations. On this deployment the number is linked straight away: no code is sent and none is needed, so do not call confirmWhatsappCode. Pass the number in full international format (e.g. +447700900000). On success the result says the number is linked and includes a wa.me chat link — give it to the user so they can open WhatsApp and start messaging Listen-Fire in one tap. A number must be linked before a WhatsApp listener will fire for that person. If the number is already linked to a different account, the call returns a clear reason.",
};

const WHATSAPP_CONFIRM_DESCRIPTION: Record<WhatsappLinkVerification, string> = {
  otp: "Finish linking a WhatsApp number by confirming the code the user received. Pass the same number given to linkWhatsappNumber and the code. On success the number is verified and the user's messages to the Listen-Fire WhatsApp number will run their automations, and the result includes a wa.me chat link — give it to the user so they can open WhatsApp and start messaging Listen-Fire in one tap. A wrong, expired, or already-used code returns a clear reason so you can ask the user to try again or request a fresh code.",
  trust:
    'Not needed on this deployment: linkWhatsappNumber links a number straight away without a code. Calling this returns a reason saying no code is needed.',
};

// What the connector tells a client on `initialize`. Reference material only:
// how to talk to the user, and what to ask them before going live, lives in the
// builder skill, never here: behaviour served by a connector reads as injected
// instructions, and a second voice competes with the skill's.
const AUTOMATION_INSTRUCTIONS =
  "To automate anything for the user — react to events, move data between their systems, push into their CRM or chat — build an \"automation\" here: a small program over their real connected systems. This connector is how you make Listen-Fire DO things.\n\n" +
  "The loop. Call getStarted first: one call returns the handbook's front page (where this language differs from TypeScript, the few ideas it adds, the build loop), your team, and its connected systems with their record types and fields. The handbook's chapters are not needed: look up anything else — a built-in's signature, a system's behaviour, a recipe — with searchLanguage, and read the anchor a result or a diagnostic names with readHandbook (\"front#maybe-absent\"); where anything else disagrees with the handbook, the handbook wins. " +
  "Reconcile getStarted's systems against the task — mint any missing connection first via connectSystem. Author against the real record and field names (getStarted's digest; describeConnection for more of one system), never from memory. Then saveAutomation: it validates first and saves nothing while there are errors, handing back the diagnostics, so a separate validateAutomation is not needed. Then runAutomation on real input; checkRun and inspectRun show what a run did. Make independent tool calls together, in one turn. Once something is saved, prefer a small edit over resending the whole program: readAutomation (or getAutomation, which also carries its metadata) to see the current text, grepAutomations to find where something is defined or used, and editAutomation to change it — anchored on a unique snippet plus the revision you just read, so a concurrent edit is caught instead of clobbered. Reach for saveAutomation itself only for a brand-new automation or a genuine rewrite. A write a third party sees (an email, a message to someone else) gets an approval step inside the automation — a question a person acts on. The user's knowledge graph is reachable as the `kg` system in listConnections.\n\nTeams. This connection may span several teams; getStarted lists them with their ids. Creating or changing anything in a team needs its id as `team`; with exactly one team you may omit it.";

/** The connector as served: what a client is told and the tools it is offered. */
function automationConnectorOptions(): McpRouterOptions {
  const linkVerification = whatsappLinkVerification();
  return {
    name: 'listen-fire-automation',
    domain: 'automation',
    genericApiTools: false,
    instructions: AUTOMATION_INSTRUCTIONS,
    tools: {
      getStarted: {
        description:
          "START HERE, in one call: the automations handbook's front page, your team, and its connected systems — how to import and construct each, its record types with their fields (`!` required, `*` identifying), and what a listen on it may say. When this connection spans several teams and you name none, it lists them with their ids instead of the systems; call again with `team`. Enough to write a first automation: describeConnection goes deeper on one system, searchLanguage answers a lookup.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          team: z
            .string()
            .optional()
            .describe('Team id; needed only when this connection spans several teams.'),
        },
        title: 'Get started',
        endpoint: { method: 'GET', path: '/v1/automation/get-started' },
      },
      listTeams: {
        description:
          "List the teams this connection can act in (teamId, name, access, isPersonal). `isPersonal: true` marks the user's personal workspace (their team-of-one) vs a shared team. Pass a team's id as `team` to tools that create or change things (saveAutomation, runAutomation, connectSystem, …). listAutomations and listReviews already tag their results with the team.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
        title: 'List your teams',
        endpoint: { method: 'GET', path: '/v1/automation/teams' },
      },
      listReviews: {
        description:
          "List the open reviews (interaction requests) from paused automation runs that are waiting on an answer. Each returns a requestId, interactionType (Check / Choose / Pick / Review / Notify / …), result type, and title. Poll this to discover what's waiting on your review, then answer with submitReview.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
        title: 'List items waiting for your review',
        endpoint: { method: 'GET', path: '/v1/automation/reviews', inputLocation: 'query' },
      },
      submitReview: {
        description:
          "Submit the user's response to an item a paused automation run is waiting on; the run then resumes. Pass the requestId (from listReviews) and the answer SHAPED to the review's interactionType — pass the structured value, do NOT stringify it:\n" +
          '• Check → a boolean (true / false).\n' +
          "• Choose → the chosen enum member; Pick / Select → the chosen option id (or an array of ids for a multi-select). Use the option ids from the review's args.\n" +
          "• Provide → the value matching the review's resultType (a number for a number result, a string for text, etc.).\n" +
          '• Review / Notify → an acknowledgement string (e.g. "ack").\n' +
          "• Correct → the edited review table as { rows: [{ ephemeralId, fields }], dropped: [ephemeralId, …] }. Take the records from the review's args.correct.rows, apply the user's corrections to each row's fields, keep each kept row by its ephemeralId, and list any removed records' ephemeralIds in `dropped`.",
        inputSchema: {
          requestId: z.string().describe("The review's requestId (from listReviews)"),
          // The answer is structured per interaction kind — a boolean, a string,
          // a number, a list of option ids, or a Correct edit object { rows,
          // dropped }. Accept any JSON value and forward it as-is (no
          // stringification); recordAnswer validates it against the result type.
          answer: z
            .union([
              z.boolean(),
              z.number(),
              z.string(),
              z.array(z.unknown()),
              z.record(z.string(), z.unknown()),
            ])
            .describe(
              "The answer, shaped to the review's interactionType (see the tool description). A boolean for a Check; an option id / array of ids for Pick/Select; a number/string value for Provide; { rows, dropped } for a Correct. Passed through and validated server-side — do not stringify.",
            ),
        },
        title: 'Submit your review',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/reviews/:requestId/answer' },
      },
      sendFeedback: {
        description:
          "Send this deployment's operator a short feedback note when you or the user hit friction — something confusing, broken, missing, or harder than it should be while automating. Use it proactively whenever the experience gets in the way (a tool that won't do what's needed, a connector that can't connect, a repeated dead-end), and whenever the user voices a complaint or a wish. It's a one-way report to the person who runs this deployment — it does NOT fix the problem or reply to the user, so don't offer it as a solution; just file it and carry on. `goal` = what the user was trying to achieve, `friction` = what went wrong or got in the way (be specific and concrete).",
        inputSchema: {
          goal: z
            .string()
            .describe(
              'What the user was trying to achieve, in plain terms (e.g. "sync new Gmail leads into Attio").',
            ),
          friction: z
            .string()
            .describe(
              'What went wrong or got in the way — the specific difficulty, dead-end, or confusion. Concrete details help the operator act on it.',
            ),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); defaults to the acting team.'),
        },
        title: 'Send feedback to the operator',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/feedback' },
      },
      readHandbook: {
        description:
          'getStarted already serves the automations handbook\'s front page; read here for an anchor a searchLanguage result or a diagnostic names ("front#maybe-absent", "writes#identity", "system:slack"), or another handbook. For automations, look things up with searchLanguage rather than reading chapters: a whole hand-written automations chapter answers with a pointer to it, while its sections, system and plugin chapters, and the front page\'s sections read in full. The other Listen-Fire handbooks (the knowledge model, querying, connecting integrations) read by chapter. No args → every handbook + its chapters. handbook → that handbook\'s chapter index (the automations handbook: its front page). handbook + chapter (or chapters[]) → the bodies — go straight there when you know what you need; you don\'t have to list the shelf first.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          handbook: z
            .string()
            .optional()
            .describe(
              'Handbook id from the shelf (call readHandbook with no arguments to list them), e.g. "automations", "knowledge-model", "using-listen-fire".',
            ),
          chapter: z
            .string()
            .optional()
            .describe('A single anchor: a section ("writes#identity", "front#maybe-absent") or a system\'s chapter ("system:slack").'),
          chapters: z
            .array(z.string())
            .optional()
            .describe(
              'Several anchors to read in one call, e.g. ["front#maybe-absent","writes#identity","system:slack"].',
            ),
        },
        title: 'Read the Listen-Fire handbook',
        endpoint: { method: 'POST', path: '/v1/automation/handbook' },
      },
      searchLanguage: {
        description:
          'Look up the automation language: a built-in function (its signature, generated from the language itself), a concept, a recipe, or what a system or plugin documents. Ask in words ("join text", "update or create a record", "wait for an approval") or by name ("COALESCE"). Returns a few entries, each with its purpose, signature or short text, an example, and an anchor to read in full with readHandbook.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          query: z.string().describe('What you need, in words or by name.'),
          kind: z
            .enum(LANGUAGE_SEARCH_KINDS)
            .optional()
            .describe('Only this kind: "function", "concept" or "recipe".'),
        },
        title: 'Search the automation language',
        endpoint: { method: 'POST', path: '/v1/automation/language/search' },
      },
      listConnections: {
        description:
          'The connected systems list: the workspace\'s real systems (with construction args + listener-config keys), connections, plugins, and knowledge-graph type names. These are the ONLY names valid in automation imports and constructions — never invent one. Each system carries how it connects — `connect`: "oauth" (browser sign-in), "key-entry" (paste an API key), "intrinsic" (part of Listen-Fire — one-click setup, no sign-in, e.g. Listen-Fire Valuations), "handshake" (the link hands the user into the system\'s own linking flow, e.g. Telegram\'s bot Start step), or "app-only" (connected inside the Listen-Fire app — connectSystem can\'t link it); absent means it needs no connection. Where a system carries `triggerExpectation`, that is the plain-language truth about WHICH events a listener on it actually fires on (e.g. which Telegram messages reach the bot) — ground every trigger-surface claim you make to the user in it rather than guessing. Call describeConnection for a system\'s live field schema before authoring against it.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'List connected systems',
        endpoint: { method: 'GET', path: '/v1/automation/connections' },
      },
      describeConnection: {
        description:
          "The live shape of one connected system, ONE PLACE AT A TIME, as compact text in getStarted's notation. Every call re-reads the system's live schema, so it's safe to call again right after adding a field in the external workspace; the field names you write must match it exactly. Omit `position` and you stand at the system's ROOT: how to construct it, what a listen on it may say (its events and config keys), what it fires on, who it runs as, its limits, and every record type with its fields. Pass a `position` and you get that node's fields and every edge leaving it, each as `-[:Edge]-> Target (many|one) [r w fires]` followed by the target's fields, one level deep — enough to author a read or write with no further call. Field marks: `!` required to create, `*` identifies the record (a `unique by` candidate), `~` read-only, `(write-only)` writable but never read back; a `backticked` name keeps its backticks in code; `enum(a|b|…+N)` lists the first options and counts the rest. An edge whose target says `fields not loaded` is one hop away: describe its position. A polymorphic edge lists its members, each with the narrowed hop that reaches it (`-[:Base WHERE `Name` == \"CRM\"]->`) — the same spelling an automation writes. `detail: \"full\"` returns the full JSON instead: every description, edge capabilities, the projected write shapes and the raw schema — needed rarely, and many times larger. Also useful BEFORE anything is connected: the root still says what the system is, what a listen fires on, and who it runs as — ground scope, identity and capability claims to the user in these.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          system: z
            .union([z.string(), z.array(z.string())])
            .describe(
              'The system name (from listConnections), e.g. "attio". Pass an array (e.g. ["slack","attio"]) to describe several systems in one call — preferred when your automation touches more than one.',
            ),
          connection: z
            .string()
            .optional()
            .describe('Which connection to describe against (defaults to the system name).'),
          types: z
            .array(z.string())
            .optional()
            .describe(
              'Ask for these type names by name instead of walking to them. Rarely needed — prefer `position`, which is how the system tells you what exists. An entry may also be a PATH, the traversal that reaches a type written exactly as in an automation: \\"-[:`Sales CRM`]->-[:Companies]->\\".',
            ),
          position: z
            .string()
            .optional()
            .describe(
              "WHERE TO STAND in the system. Omit it and you get the system's root: what it is, and every edge leaving it. The answer describes that one place — its fields, and each edge with what you would LAND ON if you followed it (so you can author a write straight away, with no further call). To look deeper, pass this position followed by one of its edges (the answer shows an example to copy): that is one hop, and the only thing a hop buys you is the landing's OWN edges. Only walk edges a previous call showed you.",
            ),
          detail: z
            .enum(['compact', 'full'])
            .optional()
            .describe(
              'How much to say. Omit for the compact text (what you author against). "full" returns the JSON: every description, edge capabilities and the projected write shapes, at many times the size.',
            ),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Describe a connected system',
        endpoint: { method: 'POST', path: '/v1/automation/connections/describe' },
      },
      connectSystem: {
        description:
          'AUTHOR-TIME ONLY: if a system the automation needs is NOT yet connected (absent from the connected systems list, or it has a "no connection" note), mint a single-use connection link and give it to the user to open in their browser. Works for the "oauth", "key-entry", "intrinsic", and "handshake" connect kinds listConnections reports. Do NOT call it for an "app-only" system: it has no link path and connects inside the Listen-Fire app — tell the user to connect it there. Returns a link to send the user, the connect kind, the name the connection will be stored under, and when the link expires. Relay the url to the user ("open this to connect <system>"); once they confirm, call listConnections again — the connection shows up in the results once it lands (for "handshake" it appears when they click Connect; remind them to also press Start in Telegram or inbound messages won\'t route).',
        inputSchema: {
          system: z
            .string()
            .describe(
              'The system name to connect (from listConnections), e.g. "attio", "google_sheets", "slack", "airtable", "dropbox".',
            ),
          connection: z
            .string()
            .optional()
            .describe('Optional name to store the connection under (defaults to the system name).'),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Get a link to connect a system',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/connections/connect' },
      },
      grantAccess: {
        description:
          "AUTHOR-TIME: some systems need access granted to specific items INSIDE an already-connected account — connecting the system isn't enough. Google Sheets is the current case: under Google's drive.file scope, picking is the ONLY way Listen-Fire can reach a pre-existing spreadsheet, and only the picked file becomes visible. Mint a single-use link that opens the provider's picker; relay the url to the user. After they pick, call describeConnection for that system — the granted items' types appear as writable types. Connect the system first (connectSystem) if it isn't connected at all. For a NEW spreadsheet skip the link entirely: automations can create one (write the Spreadsheet type) and access is automatic. Systems that don't need per-item grants return a clear error.",
        inputSchema: {
          system: z
            .string()
            .describe('The system name (from listConnections), e.g. "google_sheets".'),
          connection: z
            .string()
            .optional()
            .describe(
              'Which connection the items should be granted to. Omit when the team has exactly one.',
            ),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Get a link to grant access to items',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/connections/grant-access' },
      },
      linkWhatsappNumber: {
        description: WHATSAPP_LINK_DESCRIPTION[linkVerification],
        inputSchema: {
          phoneNumber: z
            .string()
            .describe(
              "The user's WhatsApp number in full international format, e.g. +447700900000.",
            ),
        },
        title: 'Link a WhatsApp number',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/whatsapp/verify/start' },
      },
      confirmWhatsappCode: {
        description: WHATSAPP_CONFIRM_DESCRIPTION[linkVerification],
        inputSchema: {
          phoneNumber: z
            .string()
            .describe('The same number passed to linkWhatsappNumber, full international format.'),
          code: z.string().describe('The verification code the user received on WhatsApp.'),
        },
        title: 'Confirm a WhatsApp code',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/whatsapp/verify/confirm' },
      },
      validateAutomation: {
        description:
          'Typecheck an automation program against the live connected systems WITHOUT saving: parse, check, and compile. Returns diagnostics (code, message, severity, line/col, offending line) and `validatedUnder` — the language version it was checked against. A clean validation predicts a live save. saveAutomation runs this same check first and saves nothing on errors, so you need not call this before saving — use it to explore. When changing a saved automation, pass its id as `automation` so the text is checked under the language version that automation is written in; new text is checked under the current version.',
        inputSchema: {
          source: z.string().describe('The automation program text (.mvt).'),
          team: z.string().optional().describe('Team id (see instructions).'),
          automation: z
            .string()
            .optional()
            .describe(
              'The saved automation this text belongs to (id from listAutomations) — it is then checked under that automation\'s language version.',
            ),
          languageVersion: z
            .number()
            .int()
            .optional()
            .describe(
              'Check under this language version (the integer from listAutomations\' `languageVersion`) instead — e.g. to see what an older automation would need to move to the current version.',
            ),
        },
        title: 'Validate an automation',
        annotations: { readOnlyHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/validate' },
      },
      upgradeAutomation: {
        description:
          "Move a saved automation onto the current version of the automation language. Every automation is written in a language version (listAutomations' `languageVersion`); an older one keeps running exactly as it always has, and `upgradeDiagnostics` in listAutomations lists what stands between it and the current version. This validates it under the current version and returns `status`, `from`, `to`, `diagnostics` and a `message`: `blocked` — repair the diagnostics (validateAutomation with `languageVersion` set to `to.version`), save, and call again; `needs_acknowledgement` — it has no errors, and a second call with acknowledge: true moves it (any diagnostics listed are constructs whose meaning changes under the new version: read them and edit what assumed the old behaviour first); `upgraded`; `already_current`; `unverified` — a connected system could not be read. Nothing changes without acknowledge: true. An error blocks. A diagnostic marking a construct whose meaning changed between versions is shown, and the caller acknowledges it to move up. Any other warning (a cost note, say) reads the same under both and never blocks, so it is not listed.",
        inputSchema: {
          automation: z.string().describe('The automation id (from listAutomations).'),
          acknowledge: z
            .boolean()
            .optional()
            .describe(
              'Move it once the check is clean. Without it, the call only reports. Pass it after telling the user what upgrading changes (nothing, when the result is clean).',
            ),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Upgrade an automation to the current language version',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/automations/upgrade' },
      },
      saveAutomation: {
        description:
          'Save an automation program and provision its listeners (authoring → live). It validates first, exactly as validateAutomation does, so there is no need to call that before: with any error, or a system it could not check, NOTHING is saved and you get { ok: false, saved: false, diagnostics } — fix them and save again. A clean save goes live. Pass acknowledgeErrors: true to ship it despite errors: it then replaces whatever was running (even broken) and will run and fail visibly. There is no "draft" that quietly keeps the last good version running — what goes live is what you save and confirm. When updating an EXISTING automation, pass expectedRevision so a concurrent edit is caught rather than silently overwritten. Returns the provisioned listeners (each channel and the inbound address for email), whether an on-demand run is possible (runnable), storyUrl, `diagnostics` when a clean save still has warnings, and `warnings` — things that saved fine but would surprise the user (a movement name another automation already fires; listeners retired because the saved source could not be read). Always relay a warning to the user in your own words. storyUrl is a link to a picture of what the automation does — its triggers, steps, and the records it touches — for a person to look at, not something you can open yourself; hand it out as a labelled link once the save goes live. Anyone holding it can view with no login, until the automation is deleted. Pass id to re-save/rename. For a small, targeted change to an existing automation — one line, one field — editAutomation is cheaper: it anchors the change on a snippet instead of resending the whole program.',
        inputSchema: {
          source: z.string().describe('The automation program text (.mvt).'),
          name: z
            .string()
            .optional()
            .describe('Human-readable display name (plain words, no underscores).'),
          description: z.string().optional().describe('Optional one-line description.'),
          id: z
            .string()
            .optional()
            .describe('Existing automation id when re-saving/renaming (from listAutomations).'),
          acknowledgeErrors: z
            .boolean()
            .optional()
            .describe(
              'Consent to ship an automation that has errors or cannot be verified. Without it, such a save is refused and nothing is saved. With it, the automation ships and replaces whatever was running (even broken), so it runs and fails visibly — only pass it once the user has agreed to that. If the source cannot even be READ (a syntax error), shipping it also retires every listener the automation had: it stops firing entirely until a readable source restores them, and the result says so in `warnings`.',
            ),
          expectedRevision: z
            .string()
            .optional()
            .describe(
              "The `revision` returned by your last getAutomation call for this automation. When updating an existing automation, pass it so a concurrent edit can't be silently overwritten — a mismatch (someone saved a newer version since) is rejected; call getAutomation again, merge, and re-save with the new revision. Omit to save regardless of what changed.",
            ),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Save an automation',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/save' },
      },
      deleteAutomation: {
        description:
          'Permanently delete a saved automation and every listener it derives — a HARD delete: the automation and its run triggers are removed, and any external subscriptions it alone kept alive are torn down. There is no undo. Pass the automation id (from listAutomations). Returns { deleted } — false if no automation with that id lives in the resolved team.',
        inputSchema: {
          automation: z.string().describe('The automation id to delete (from listAutomations).'),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Delete an automation',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/delete' },
      },
      listAutomations: {
        description:
          "List the saved automations across every team this connection covers: each one's id, name, status, listeners, storyUrl, the team it lives in (teamId, teamName), its `languageVersion` (the version of the automation language it is written in, as { version, name }), `checkedAgainst` (the version its last check ran under), and `upgradeDiagnostics` — when it is on an older language version, what stands between it and the current one (null when nothing does or nothing is recorded; see upgradeAutomation). Use the id with getAutomation, saveAutomation, or runAutomation. storyUrl is a link to a picture of what an automation does, for a person to look at — you can't open it yourself, so hand it out as a labelled link when they want to see one. Anyone holding a link can view it with no login, until that automation is deleted.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
        title: 'List automations',
        endpoint: { method: 'GET', path: '/v1/automation/automations' },
      },
      getAutomation: {
        description:
          "Get one saved automation by its id or exact name (looked up across the teams this connection covers): the full program text, status, listeners, `revision` — a fingerprint of its current source — `languageVersion` and `checkedAgainst` (as in listAutomations), and storyUrl. When you only need the text (or part of it), readAutomation is cheaper; reach for this one when you also want the metadata alongside it. Re-read this or readAutomation (don't reuse an old copy) right before you edit and re-save an existing automation, and pass its `revision` back as saveAutomation's or editAutomation's expectedRevision — that way a concurrent edit by someone else is caught as a conflict instead of silently overwritten. storyUrl is a link to a picture of what it does (its triggers, steps, and the records it touches), for a person to look at — you can't open it yourself, so hand it out as a labelled link when they want to see it. Anyone holding the link can view with no login, until the automation is deleted. In a chat that can show it, that same picture is drawn right below this answer, so there is no need to describe it.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          idOrName: z
            .string()
            .describe('The automation id (from listAutomations) or its exact name.'),
        },
        title: 'Get an automation',
        endpoint: { method: 'GET', path: '/v1/automation/automations/:idOrName' },
        app: storyApp,
      },
      readAutomation: {
        description:
          "Read an automation's program text a window at a time, by id or exact name — cheaper than getAutomation when you only need to see (or re-check) part of a long file. Pass offset (1-based line number, default 1) and limit (line count, default the rest of the file). Returns { id, name, revision, totalLines, offset, lines: [{ n, text }] }. Line numbers are only valid against THIS read — anything else that edits the file moves them, so anchor an edit on the text itself (editAutomation), never on n.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          idOrName: z
            .string()
            .describe('The automation id (from listAutomations) or its exact name.'),
          offset: z.number().int().min(1).optional().describe('1-based line number to start from. Default 1.'),
          limit: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('How many lines to return. Default: the rest of the file.'),
        },
        title: 'Read part of an automation',
        endpoint: { method: 'GET', path: '/v1/automation/automations/:idOrName/source' },
      },
      editAutomation: {
        description:
          "Change one saved automation by splicing a snippet into it, without resending the whole program. Pass its id or exact name, oldString, and newString; oldString must appear in the CURRENT source exactly once — read it first (readAutomation or getAutomation) and quote enough surrounding text to pin one spot — or the edit is refused, telling you whether the anchor was not found or matched more than once (pass replaceAll: true to change every match instead of widening the anchor). Once the anchor resolves, this IS saveAutomation with the spliced result as the new source: pass expectedRevision (the revision you just read) so a concurrent edit is caught rather than clobbered, and the same check runs first — an edit with errors is not saved and its diagnostics come back; acknowledgeErrors ships it anyway, exactly like save. There is no draft lane: an edit to a saved library is visible to every importer immediately. Returns save's result plus the new revision.",
        inputSchema: {
          idOrName: z
            .string()
            .describe('The automation id (from listAutomations) or its exact name.'),
          oldString: z.string().describe('The exact text to find in the current source.'),
          newString: z.string().describe('The text to put in its place.'),
          replaceAll: z
            .boolean()
            .optional()
            .describe('Replace every match instead of requiring oldString to be unique.'),
          expectedRevision: z
            .string()
            .optional()
            .describe(
              "The `revision` from your last read of this automation. A mismatch (someone saved a newer version since) is rejected as a conflict instead of overwriting; re-read and retry with the new revision.",
            ),
          acknowledgeErrors: z
            .boolean()
            .optional()
            .describe(
              'Consent to ship the edit even if it has errors or cannot be verified — same as saveAutomation\'s acknowledgeErrors.',
            ),
        },
        title: 'Edit an automation',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/:idOrName/edit' },
      },
      grepAutomations: {
        description:
          'Search across your automations for a literal snippet (or, with isRegex: true, a regular expression) and get back every matching line: { matches: [{ id, name, teamId, line, text, before, after }], truncated }. contextLines adds lines of surrounding context per match (default 0). Spans every team this connection covers unless you pass team. Capped at 200 matches. Use it to find where something is defined or used before you edit it.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          pattern: z.string().describe('The text to search for.'),
          isRegex: z.boolean().optional().describe('Treat pattern as a regular expression.'),
          contextLines: z
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe('Lines of context to include before/after each match. Default 0.'),
          team: z.string().optional().describe('Team id (see instructions). Default: every team this connection covers.'),
        },
        title: 'Search your automations',
        endpoint: { method: 'GET', path: '/v1/automation/automations/grep' },
      },
      runAutomation: {
        description:
          'Dispatch a saved automation and return IMMEDIATELY with { runId, status: "running" } — the run executes asynchronously and may take a while (extraction + writes), so it does NOT wait for completion. The automation must declare a manual channel (it goes live with one). Pass the automation id (from listAutomations / getAutomation), optionally text and/or files as its input. Then POLL checkRun with the runId until status leaves "running".',
        inputSchema: {
          automation: z
            .string()
            .describe('The automation id to run (from listAutomations / getAutomation).'),
          text: z.string().optional().describe("Free-form text to supply as the run's input."),
          files: z
            .array(
              z.object({
                filename: z.string(),
                contentType: z.string(),
                contentBase64: z.string().describe('Base64-encoded file bytes.'),
              }),
            )
            .optional()
            .describe("Files to supply as the run's input."),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Run an automation',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/run' },
      },
      checkRun: {
        description:
          'Read one automation run\'s status by id — the poll target for runAutomation\'s async dispatch. Pass the runId returned by runAutomation. Returns { status, recordCount, errors, startedAt, finishedAt, failedAt, failureReason, costUsd, modelCalls, paused? }. status is "running" while it executes, then settles to "success" / "partial" / "failed" (or "parked" — paused, waiting for your review — see listReviews). A parked run that carries `paused` stopped because it reached its cost limit: `paused` says what it spent and the limit, and resumeRun carries it on (with its usage reset). Poll every few seconds until status leaves "running". costUsd is the run\'s model-call spend in dollars (0 if it made none); modelCalls is how many calls it made. To see WHAT the run captured and wrote (source event + resolved field values), call inspectRun.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          runId: z.string().describe('The run id returned by runAutomation.'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: "Check a run's status",
        endpoint: { method: 'POST', path: '/v1/automation/automations/run-status' },
      },
      listRuns: {
        description:
          'List an automation\'s recent runs (every listener firing and "Run now"), newest first — this is how you find the runId for an automation that fired on its own (not just one you launched with runAutomation). Returns each run\'s { runId, lane (which listener), triggerType, status, committed, captured, recordCount, timestamps, costUsd, modelCalls } — `committed` is how many writes actually landed in a target system, `captured` how many were rehearsed (a `dry_run` target, or a whole-run rehearsal), `costUsd`/`modelCalls` the run\'s model-call spend and call count. Pass a runId to inspectRun to see what it actually captured and wrote. Pass the automation id or its exact name.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          idOrName: z
            .string()
            .describe('The automation id (from listAutomations) or its exact name.'),
          limit: z.number().optional().describe('Max runs to return (default 20, newest first).'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: "List an automation's runs",
        endpoint: { method: 'GET', path: '/v1/automation/automations/:idOrName/runs' },
      },
      inspectRun: {
        description:
          'See what a run actually did. Pass a runId (from listRuns or checkRun) and get back the source event that fired it, the resolved write-plan — every target record and the FINAL field values it wrote, with every set-if-empty (`?:`) rule and enum coercion already applied, each write flagged `committed` (it landed) or not (it was rehearsed — a `dry_run` target, or a whole-run rehearsal) — the decision trace (gate/branch outcomes, extraction emissions), and any errors, plus the run\'s `committed`/`captured` counts and its `costUsd`/`modelCalls` model-call spend. A FAILED run still lists the writes that landed before it stopped — check them before re-running, or you may write the same records twice. The "did it do what I meant?" surface: use it to verify an automation before trusting a live listener, and to read back exactly which writes a rehearsal captured versus committed.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          runId: z.string().describe('The run id (from listRuns, runAutomation, or checkRun).'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: 'Inspect a run',
        endpoint: { method: 'POST', path: '/v1/automation/automations/inspect-run' },
      },
      cancelRun: {
        description:
          "Stop a run by id — one that's executing or one that's paused waiting on something. Everything the run already did stays done; it just won't do anything more. An executing run stops at its next safe point (usually within seconds). Pass the runId from listRuns / runAutomation / checkRun.",
        annotations: { destructiveHint: true },
        inputSchema: {
          runId: z
            .string()
            .describe('The run id to stop (from listRuns, runAutomation, or checkRun).'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: 'Cancel a run',
        endpoint: { method: 'POST', path: '/v1/automation/automations/cancel-run' },
      },
      resumeRun: {
        description:
          'Resume a run that paused because it reached its cost limit — checkRun shows such a run with status "parked" and a `paused` object saying what it spent and the limit. Every part of the run that stopped carries on from exactly where it stopped (nothing it already did is done again), and its usage resets, so the limit applies afresh. Confirm with the user first: resuming lets it spend up to the limit again. Pass the runId from listRuns / checkRun.',
        annotations: { destructiveHint: true },
        inputSchema: {
          runId: z
            .string()
            .describe('The paused run to resume (from listRuns or checkRun).'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: 'Resume a paused run',
        endpoint: { method: 'POST', path: '/v1/automation/automations/resume-run' },
      },
    },
  };
}

function createAutomationMcpRouter(): ReturnType<typeof Router> {
  return createMcpRouter(automationConnectorOptions());
}

export { AUTOMATION_INSTRUCTIONS, AUTOMATION_MCP_PATH, automationConnectorOptions, createAutomationMcpRouter };
