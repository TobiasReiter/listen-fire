// The bundled plugins, as data: each one's signature and whether it may cost
// money. Moved here from the product shell (Plan 22 #3 C3) so every host reads
// the same surface: the hosted catalog projects it for the checker, and the
// module that runs them (`@lf/web`, modules/web) pairs each declaration with
// its body, failing as it loads when the two do not match one to one.
//
// Running a plugin is the host's (`llm.transforms.invoke`); nothing here runs.

import type { PluginSpec } from 'movement-lang';
import type { TransformSignature } from '../translation_graph/types';

import { pluginDeclarationNamed, pluginSpecOf, pluginSpecsOf, type PluginDeclaration } from './spec';

/**
 * Public signature — surfaced through the registry. The editor uses
 * `additions.edges.vcUrl` to power downstream traversal autocomplete:
 * `(msg)-[urls:#transform { plugin: "vc-url-retrieval" }]->(:Url)` then
 * `urls.name / urls.url / urls.file / urls.text` resolves at extract
 * time.
 *
 * `params.text` is what the transform scans for URLs. One parameter, two ways
 * of being filled: inside a `through [ … ]` stage the engine populates it from
 * the extract source, so the author writes `through [vc_url_retrieval]` and
 * nothing else; called plainly there is no extraction to fill it, so the
 * caller writes `vc_url_retrieval(text: …)` themselves.
 *
 * `params.email` is author-supplied: the email to type into an
 * email-gated link (DocSend, a data room, …) if fetching one requires
 * it. No implicit guessing — a run with no email simply can't get past
 * a gate and that URL is skipped, not silently mistyped.
 */
const VC_URL_RETRIEVAL_SIGNATURE: TransformSignature = {
  name: 'vc-url-retrieval',
  description:
    'Discover, classify, and fetch URLs in a message. Emits one ephemeral Url record per fetched resource.',
  params: [
    {
      name: 'text',
      type: { kind: 'string' },
      required: true,
      // Engine-injected INSIDE A STAGE, from the extract source — the author
      // writes `through [vc_url_retrieval]` with no argument, and a stage that
      // wrote one would be overriding what it is there to receive. A plain call
      // has no stage behind it, so it writes this itself.
      auto: true,
      description: 'The text to scan for URLs. Inside a stage the extraction supplies it.',
    },
    {
      name: 'email',
      type: { kind: 'string' },
      description:
        'The email to type into an email-gated link (DocSend, a data room, …) if one of the ' +
        'discovered URLs needs it to view. Usually @user_email — @actor_email if the link was ' +
        'shared with the original sender rather than the team.',
    },
  ],
  dataDependency: 'none',
  // What it does, declared: it fetches the pages it discovers, and it asks a
  // model to classify each one (`classifyUrl`). Nothing else — it writes
  // nowhere, reads no clock, and never parks.
  effects: { reads: ['the web'], ai: true },
  additions: {
    edges: {
      vcUrl: {
        target: {
          kind: 'list',
          element: {
            kind: 'record',
            fields: {
              name: { kind: 'string' },
              url: { kind: 'string' },
              file: { kind: 'file' },
              text: { kind: 'string' },
            },
          },
        },
      },
    },
  },
  // One record per link it fetched, in the order it found them — a message can
  // carry several decks, and each keeps its own link, file and text. An empty
  // list when there was no link worth following. `file` is there only when the
  // link was a document it could store; `text` only when it could read some.
  output: {
    kind: 'records',
    fields: {
      name: { type: { kind: 'string' }, description: 'What the fetched page is called.' },
      url: { type: { kind: 'string' }, description: 'The link it followed.' },
      file: {
        type: { kind: 'file' },
        optional: true,
        description: 'The downloaded document, when the link was one.',
      },
      text: {
        type: { kind: 'string' },
        optional: true,
        description: 'The text read out of the page or document.',
      },
    },
    description: 'Every link it fetched, one record each. Empty when there was no link worth following.',
    // Language version 1: every page it fetched as one text.
    previously: [
      {
        before: 2,
        output: {
          kind: 'value',
          type: { kind: 'string' },
          optional: true,
          description:
            'The text of every page it fetched, run together. Nothing when there was no link '
            + 'worth following.',
        },
      },
    ],
  },
};

/**
 * `params.url` is required and author-supplied. It is normally a field an
 * earlier stage extracted (`fetch_url(url: website)`), which is what makes a
 * per-record stage load a per-record page. A required argument that resolves
 * absent skips the invocation at the stage boundary (see
 * `movement_engine/extraction.ts`), so a record whose website came back empty
 * simply gets no enrichment — this implementation never sees a blank url.
 *
 * `params.email` / `params.password` are the credentials a gated link
 * (DocSend, a data room, …) demands before it will show its content. They
 * reach only the gated-document path; a plain web page and a profile page
 * ignore both.
 */
const FETCH_URL_SIGNATURE: TransformSignature = {
  name: 'fetch-url',
  description:
    'Fetch one named URL and hand back its content. Emits a single ephemeral Url record.',
  params: [
    {
      name: 'url',
      type: { kind: 'string' },
      required: true,
      description:
        'The link to load. Normally a field an earlier stage extracted, so each record loads ' +
        'its own page. A bare host is read as an https address.',
    },
    {
      name: 'email',
      type: { kind: 'string' },
      description:
        'The email to type into a link that is gated behind one (DocSend, a data room, …). ' +
        'Usually @user_email — @actor_email if the link was shared with the original sender ' +
        'rather than the team. Ignored by a link that has no gate.',
    },
    {
      name: 'password',
      type: { kind: 'string' },
      description:
        'The passcode to type into a gated link alongside the email. Ignored by a link that ' +
        'has no gate.',
    },
  ],
  // The url it loads comes from the fields the enclosing extract has produced,
  // so it is a stage of an extraction and only makes sense as one.
  dataDependency: 'extracted_context',
  // What it does, declared: it fetches one page. No model is consulted —
  // the author already said which link this is.
  effects: { reads: ['the web'] },
  additions: {
    edges: {
      fetchedUrl: {
        target: {
          kind: 'record',
          fields: {
            name: { kind: 'string' },
            url: { kind: 'string' },
            file: { kind: 'file' },
            text: { kind: 'string' },
          },
        },
      },
    },
  },
  // Called plainly, what it hands back is the page's text — and nothing, when
  // the load failed or the page was empty. One value: the other three things on
  // the edge (the name, the url, the file) are what an EXTRACTOR reads, and a
  // caller who wanted the url already has it, because they passed it.
  output: {
    kind: 'value',
    type: { kind: 'string' },
    optional: true,
    description: "The page's text. Nothing when the load failed or the page was empty.",
  },
};

/**
 * Public signature — surfaced through the registry.
 *
 * `extractedContext` is consumed at runtime (not declared as a param);
 * the engine threads it through from the enclosing `#extract`. The
 * transform expects an object whose values are label/value pairs
 * describing the person — e.g. `{ name: { label, value }, … }` — but
 * also handles the flat `{ label: value }` shape the legacy plugin
 * worked with.
 */
const LINKEDIN_ENRICHMENT_SIGNATURE: TransformSignature = {
  name: 'linkedin-enrichment',
  description:
    'For an identified person without a LinkedIn profile, find their profile — searching the web for it unless the person already carries the address — and attach the profile URL and page content.',
  params: [],
  dataDependency: 'extracted_context',
  // Searches for a profile and fetches the page, and asks a model whether the
  // result is the right person.
  effects: { reads: ['the web'], ai: true },
  additions: {
    properties: {
      linkedin_url: { kind: 'string' },
      linkedin_profile: { kind: 'string' },
    },
  },
  // What a call hands back from language version 5, where the record a stage
  // fed it is the call's argument. Before 5 nothing can call it — it is fed
  // only by an extraction — so this is read by version 5 alone.
  output: {
    kind: 'record',
    fields: {
      linkedin_url: {
        type: { kind: 'string' },
        optional: true,
        description: "The person's LinkedIn profile address, when a confident match was found.",
      },
      linkedin_profile: {
        type: { kind: 'string' },
        optional: true,
        description: 'The text of that profile page.',
      },
    },
  },
};

const LINKEDIN_RESEARCH_SIGNATURE: TransformSignature = {
  name: 'linkedin-research',
  description:
    "From a LinkedIn profile address, research what that person is currently doing — their role, their organisation, and their recent public activity — and attach a summary, a confidence, and the sources it rests on.",
  params: [
    {
      name: 'url',
      type: { kind: 'string' },
      required: true,
      description:
        'The LinkedIn profile address of the person to research. Normally a field an earlier ' +
        'stage extracted, so each person is researched from their own address.',
    },
  ],
  // The address comes from the fields the enclosing extract has produced, and
  // the record's other fields are the extra search terms, so this only makes
  // sense as a stage of an extraction.
  dataDependency: 'extracted_context',
  // Searches, fetches pages, and asks two models — the planner and the one
  // that writes the answer.
  effects: { reads: ['the web'], ai: true },
  additions: {
    properties: {
      activity_summary: { kind: 'string' },
      activity_confidence: { kind: 'string' },
      current_role: { kind: 'string' },
      current_organisation: { kind: 'string' },
      activity_sources: { kind: 'string' },
    },
  },
  // What the person is currently doing, read by name. Every field is optional:
  // a profile that could not be read confidently attaches an outcome and
  // nothing else.
  output: {
    kind: 'record',
    fields: {
      activity_summary: {
        type: { kind: 'string' },
        optional: true,
        description: 'What they are currently doing, in prose.',
      },
      activity_confidence: {
        type: { kind: 'string' },
        optional: true,
        description: 'How sure the reading is.',
      },
      current_role: {
        type: { kind: 'string' },
        optional: true,
        description: 'Their role, as stated.',
      },
      current_organisation: {
        type: { kind: 'string' },
        optional: true,
        description: 'The organisation they are at.',
      },
      activity_sources: {
        type: { kind: 'string' },
        optional: true,
        description: 'The addresses the reading rests on, one per line.',
      },
    },
  },
};

const WEB_RESEARCH_SIGNATURE: TransformSignature = {
  name: 'web-research',
  description:
    "Find a company's own website from its name and what a message said about it, and fetch it. Stands down for a record that already carries a link.",
  params: [
    {
      name: 'name',
      type: { kind: 'string' },
      required: true,
      description:
        'The name to research. Normally a field an earlier stage extracted, so each record is ' +
        'researched from its own name.',
    },
    {
      name: 'context',
      type: { kind: 'string' },
      description:
        'What the message said about it — a description, a sector, a location, the people ' +
        'behind it. This is what tells the company apart from every other use of the word, ' +
        'and without it nothing is searched for at all.',
    },
    {
      name: 'website',
      type: { kind: 'string' },
      description:
        "The record's web address, when it has one. Pass it so this stands down: a record " +
        'that already has a link needs no research, and nothing is searched or fetched for it.',
    },
    {
      name: 'linkedin',
      type: { kind: 'string' },
      description:
        "The record's LinkedIn address, when it has one. Pass it for the same reason as " +
        '`website` — the profile is a better source than a search, and the profile plugin ' +
        'has it covered.',
    },
  ],
  // The name and the context are fields the enclosing extract produced, so
  // this only makes sense as a stage of an extraction.
  dataDependency: 'extracted_context',
  // Searches, fetches one page, and asks a model twice — to plan the queries
  // and to confirm the candidate.
  effects: { reads: ['the web'], ai: true },
  additions: {
    properties: {
      website: { kind: 'string' },
    },
    // The same record `fetch-url` emits, so a stage behind either of them
    // reads the page the same way.
    edges: {
      fetchedUrl: {
        target: {
          kind: 'record',
          fields: {
            name: { kind: 'string' },
            url: { kind: 'string' },
            file: { kind: 'file' },
            text: { kind: 'string' },
          },
        },
      },
    },
  },
  // Both halves of what it did: the address it settled on, and the page it
  // fetched from there. Either can be missing — a record that already carried a
  // link makes this stand down, and a search that found nothing fetches nothing.
  output: {
    kind: 'record',
    fields: {
      website: {
        type: { kind: 'string' },
        optional: true,
        description: "The company's own web address, as found.",
      },
      text: {
        type: { kind: 'string' },
        optional: true,
        description: 'The text of the page it fetched from that address.',
      },
    },
  },
};

// The addresses are three named parameters rather than one list. A plugin
// argument that is a list LITERAL of field names checks clean and then throws
// at run time — the runtime resolves a bare field name only when it is the
// WHOLE argument — so `urls: [website, linkedin]` is not a shape an author can
// write today. Recorded in 1_contract.md.

const RESEARCH_SIGNATURE: TransformSignature = {
  name: 'research',
  description:
    'Research one person or company from whatever the record carries — a name, a line of ' +
    'context, a website, a profile address — and attach a dossier that answers what you ask, ' +
    'with its sources and a confidence.',
  params: [
    {
      name: 'name',
      type: { kind: 'string' },
      required: true,
      description:
        'The name to research. Normally a field an earlier stage extracted, so each record ' +
        'is researched from its own name.',
    },
    {
      name: 'context',
      type: { kind: 'string' },
      description:
        'What the message said about it — what it does, where it is, who is behind it. This ' +
        'is what tells the subject apart from every other use of the word, and a record with ' +
        'no address and no context is left alone rather than guessed at.',
    },
    {
      name: 'questions',
      type: { kind: 'string' },
      description:
        'What you want to find out, in your own words ("what it does, which sector, where it ' +
        'is based"). The dossier is sized to this rather than to everything the web says.',
    },
    {
      name: 'website',
      type: { kind: 'string' },
      description:
        "The record's web address, when it has one. It is read as the subject's own words, " +
        'and nothing is searched for to replace it.',
    },
    {
      name: 'linkedin',
      type: { kind: 'string' },
      description:
        "The record's profile address, when it has one. A profile address settles who the " +
        'subject is, so everything found afterwards is checked against their own headline.',
    },
    {
      name: 'url',
      type: { kind: 'string' },
      description:
        'One more address the record carries — an article, an announcement, a listing. Read ' +
        'as evidence alongside the others.',
    },
  ],
  // Name, context and addresses are fields the enclosing extract produced, so
  // this only makes sense as a stage of an extraction.
  dataDependency: 'extracted_context',
  effects: { reads: ['the web'], ai: true },
  additions: {
    properties: {
      summary: { kind: 'string' },
      confidence: { kind: 'string' },
      sources: { kind: 'string' },
      website: { kind: 'string' },
      linkedin: { kind: 'string' },
      dossier: { kind: 'string' },
    },
  },
  // The dossier, read by name. Every field is optional because every one of them
  // is filled only when the research actually found it — a subject with no
  // confident match comes back with an outcome and nothing else.
  output: {
    kind: 'record',
    fields: {
      summary: {
        type: { kind: 'string' },
        optional: true,
        description: 'A short answer to what you asked, in prose.',
      },
      confidence: {
        type: { kind: 'string' },
        optional: true,
        description: 'How sure the reading is that this is the right subject.',
      },
      sources: {
        type: { kind: 'string' },
        optional: true,
        description: 'The addresses the answer rests on, numbered, one per line.',
      },
      website: {
        type: { kind: 'string' },
        optional: true,
        description: "The subject's own web address, as resolved.",
      },
      linkedin: {
        type: { kind: 'string' },
        optional: true,
        description: "The subject's profile address, as resolved.",
      },
      dossier: {
        type: { kind: 'string' },
        optional: true,
        description: 'The long form — everything read, kept for a later question.',
      },
    },
  },
};

// Every plugin searches, scrapes or asks a model, and all of that is paid for.
export const VC_URL_RETRIEVAL_PLUGIN: PluginDeclaration = { signature: VC_URL_RETRIEVAL_SIGNATURE, priced: true };
export const FETCH_URL_PLUGIN: PluginDeclaration = { signature: FETCH_URL_SIGNATURE, priced: true };
export const LINKEDIN_ENRICHMENT_PLUGIN: PluginDeclaration = { signature: LINKEDIN_ENRICHMENT_SIGNATURE, priced: true };
export const LINKEDIN_RESEARCH_PLUGIN: PluginDeclaration = { signature: LINKEDIN_RESEARCH_SIGNATURE, priced: true };
export const WEB_RESEARCH_PLUGIN: PluginDeclaration = { signature: WEB_RESEARCH_SIGNATURE, priced: true };
export const RESEARCH_PLUGIN: PluginDeclaration = { signature: RESEARCH_SIGNATURE, priced: true };

/** The bundled plugins, in the order the catalog lists them. */
export const BUNDLED_PLUGINS: readonly PluginDeclaration[] = [
  VC_URL_RETRIEVAL_PLUGIN,
  FETCH_URL_PLUGIN,
  LINKEDIN_ENRICHMENT_PLUGIN,
  LINKEDIN_RESEARCH_PLUGIN,
  WEB_RESEARCH_PLUGIN,
  RESEARCH_PLUGIN,
];

/** The package the bundled plugins are served by (`modules/web`): a movement
 *  imports them one by one or as the package
 *  (``import { `@lf/web` as web } from plugins``). */
export const BUNDLED_PLUGINS_PACKAGE = '@lf/web';

/** Every bundled plugin's checker surface, keyed the way a program spells it,
 *  each tagged with its package. */
export function bundledPluginSpecs(): Record<string, PluginSpec> {
  return Object.fromEntries(
    Object.entries(pluginSpecsOf(BUNDLED_PLUGINS)).map(([name, spec]) => [name, { ...spec, package: BUNDLED_PLUGINS_PACKAGE }]),
  );
}

/** A bundled plugin's checker surface by either spelling, tagged with its
 *  package. */
export function bundledPluginSpecNamed(name: string): PluginSpec | undefined {
  const declaration = bundledPluginNamed(name);
  return declaration ? { ...pluginSpecOf(declaration), package: BUNDLED_PLUGINS_PACKAGE } : undefined;
}

/** A bundled plugin by either spelling (`vc_url_retrieval`, `vc-url-retrieval`). */
export function bundledPluginNamed(name: string): PluginDeclaration | undefined {
  return pluginDeclarationNamed(BUNDLED_PLUGINS, name);
}
