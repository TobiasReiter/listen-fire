// The agentic engine: one turn, Anthropic's own web tools, the guardrails in
// the prompt.
//
// The constrained engine spends a model call planning queries and another
// confirming a candidate, and everything between them is code deciding what to
// look at next. This engine hands that loop to the model: it searches and
// reads pages server-side, inside one request, and comes back with an answer
// and a record of everything it looked at. What code still owns is the two
// things a prompt cannot enforce — the anchor gate runs before the call, so a
// bare name never spends anything, and the budget is a hard `max_uses` on each
// tool rather than an instruction.
//
// What moves into the prompt is the acceptance rule, the preference for a
// subject's own domain over a directory that lists everybody, the rule that a
// famous namesake is not a match, and the rule that a wrong website is worse
// than none. They are written as refusals, because the failure they prevent is
// a confident wrong answer rather than a missing one.
//
// One host is not the model's to decide about. Anthropic's server fetcher
// refuses linkedin.com outright — and so does the page reader this engine
// supplies where there is no hosted one, because a scrape of that host returns
// its login wall, which reads as a real page and is not one. So a turn handed a
// profile address is blind to the page that anchors identity — and, told to
// read the addresses it was given, wastes a read discovering that. The profile
// is therefore read HERE,
// with the constrained engine's own primitives and caps, and handed into the
// prompt as material the turn already has. This engine is agentic about the
// web, not about LinkedIn.
//
// The answer is shaped by a second, small forced-tool call rather than by
// asking this one for JSON: a turn that has just read four pages is the worst
// possible place to also demand well-formed output.

import { z } from 'zod';

import type { ChatModelName } from 'movement-engine/public/anthropic';
import type { PageFetchResult, WebSearchResult, WebToolEvent } from 'movement-engine/public/anthropic';
import type { SearchHit } from '../search_hygiene';
import type { ProfileRead } from './profile_read';
import type {
  AnsweredExtent,
  ResearchBudget,
  ResearchEngine,
  ResearchInput,
  ResearchOptions,
  ResearchResult,
  ResearchUsage,
} from './contract';

import { defaultPageReader, meterAnthropicUsage } from 'movement-engine/public/anthropic';
import { resolveModel } from 'movement-engine/public/anthropic';
import { describeError, isLinkedInUrl } from '../addresses';
import { profileSlug } from '../linkedin_identity';
import { runSearch } from '../search_hygiene';
import { anthropicChatStructured, anthropicWebChat, logger, runFields, tools } from '../tools';
import {
  budgetOf,
  DEFAULT_RESEARCH_MODEL,
  dossierField,
  emptyUsage,
  noteFetchFailure,
  nothingFound,
  outcomeOf,
  retryFiling,
  sourcesField,
  stripVerificationOpener,
  USAGE_NOT_MEASURED,
} from './contract';
import { describeProfile, readProfile } from './profile_read';

const LOG = '[transform:research:agentic]';

// ── What this engine is allowed to spend ──────────────────────────────────
//
// The shared budget (`contract.ts`) is a CEILING both engines are held to for
// the comparison to be fair. This is the engine's own allowance inside it.
//
// It is four searches and three reads, which is what the engine has always
// had. A round at three and two was tried and withdrawn: it cost four entries
// their answers — one burned its three searches, asked for four more, took
// `max_uses_exceeded` on every one and answered nothing — while the mean wall
// clock did not move. The tail was never the tool COUNT. It was that each
// page entered the context whole and the server-side loop re-read every page
// it had opened on every later iteration, which is what the content cap in
// `web_tools.ts` now bounds.

/** Searches this engine's own turn may make, before the environment. */
const DEFAULT_AGENTIC_SEARCHES = 4;
/** Pages it may open, before the environment. */
const DEFAULT_AGENTIC_FETCHES = 3;

/** A sanity bound on a configured allowance. Not a policy — the shared budget
 *  is the policy — just wide enough that no honest setting hits it and narrow
 *  enough that a typo ("30" for "3") is caught rather than spent. */
const ALLOWANCE_LIMIT = 10;

/** A whole number of tool uses, or nothing. `RESEARCH_AGENTIC_SEARCHES` and
 *  `RESEARCH_AGENTIC_FETCHES` are read like `RESEARCH_ENGINE`: unset is the
 *  default, and so is anything that is not a whole number in range — a
 *  mistyped allowance must not silently become the allowance. */
function allowanceFrom(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  const usable = Number.isInteger(parsed) && parsed >= 1 && parsed <= ALLOWANCE_LIMIT;
  return usable ? parsed : fallback;
}

/** Reasoning depth for the research turn. `RESEARCH_AGENTIC_EFFORT` lets the
 *  comparison harness trial `low` without a deploy; anything that is not a
 *  depth the model accepts is the default rather than an error. */
function configuredEffort(): 'low' | 'medium' | 'high' {
  const raw = process.env.RESEARCH_AGENTIC_EFFORT;
  return raw === 'low' || raw === 'high' ? raw : 'medium';
}

const RESEARCH_SYSTEM = `You are researching one subject — a company or a person — and writing a short, honest dossier about it.

You have web search and a page reader. Use them; do not answer from memory. You may read a page only if its address is already in front of you: one the message gave you, or one a search returned — never a guessed or constructed address, a likely homepage or company URL you were never actually handed. A guessed address is not read; it fails.

You cannot open linkedin.com. The page reader refuses that host outright, so do not try: an attempt spends a read and returns nothing. Where the message carried a profile address it has ALREADY been read for you, and what was read appears below under "THE PROFILE, AS READ". That address anchors identity — whoever holds that profile is the subject — so nothing is attributed to the person unless it is consistent with that profile's own headline.

WHAT TO LOOK FOR, IN THIS ORDER
1. The subject's OWN page: their website, or the profile whose address you were given.
2. Recent, dated coverage that names them.
3. Everything else, which is context rather than evidence.

STOP AS SOON AS YOU CAN ANSWER
Answer the moment the questions are answered: a page that has already answered them is not a reason to open a second one, and an allowance you have not spent is not a budget to use up. A page that will not open is not opened again — say nothing about it and move on.

THE RULES YOU MUST NOT BREAK
- A source that merely matches the name is a namesake's. Accept it only if it is consistent with what you were told about the subject — the sector, the location, the people, and where the subject is a person, their own headline. Nothing is attributed to a person unless it is consistent with their own headline.
- A famous company, product, standard or framework that shares the name is NOT the subject. The subject is one a message has just noticed.
- Prefer the subject's own domain to a directory, an app store, an encyclopaedia, a jobs board or a news aggregator. Those say the name exists, which was never in doubt.
- A WRONG website is worse than none. If you are not confident a site belongs to this subject, report no website at all.
- Refuse honestly. If nothing consistent turns up, say so. Never pad an answer, and never present a plausible guess as a finding.

WHAT TO WRITE
Answer the questions you were asked and stop. Cite every claim with the address it came from. Then, under a heading "DOSSIER", quote the passages that bear on those questions, each under its source address — the quotes themselves, not a second summary, so a later reader can find a detail your answer did not anticipate. Keep the whole thing to a few paragraphs.

Write as if the caller never doubted who this is: never mention searching, which sources you kept or excluded, or that the identity checks out. Put any doubt about identity in CONFIDENCE, not in the prose.

The FIRST SENTENCE says what the subject does. Not that they match what you were told, not that the identification is consistent, not which of several candidates this is. And never close on what you could or could not retrieve — a page that would not open, an address you could not read: that is what CONFIDENCE is for, and it belongs nowhere in the prose.

End with three lines exactly:
WEBSITE: <the subject's own site, or "none">
LINKEDIN: <the profile address, or "none">
CONFIDENCE: <high | medium | low>`;

/** `found`, `answers_everything`, `confidence` and `summary` are load-bearing
 *  — there is nothing to file without them. `dossier` and `sources` are not
 *  (see `contract.ts` — the quirk this guards against is shared with the
 *  constrained engine's own synthesis call). */
const shapeSchema = z.object({
  found: z.boolean(),
  answers_everything: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string(),
  dossier: dossierField,
  sources: sourcesField,
  website: z.string(),
  linkedin: z.string(),
});

const SHAPE_SYSTEM = `You are filing a research write-up into fixed fields. The write-up is already done; do not research anything, add anything, or soften anything.

- "found": false when the write-up says nothing consistent was found.
- "answers_everything": true only when every question the caller asked is answered in the write-up.
- "confidence", "website", "linkedin": as the write-up's own last three lines state them. "none" means an empty string.
- "summary": the write-up's answer, without the dossier and without the three trailing lines. If the write-up narrates its own verification — sources kept or excluded, identity checking out — drop that framing and keep only the answers. Drop an opening sentence that announces the identification ("this matches strongly", "the subject best matching X is") and a closing note about what could or could not be retrieved: the summary starts with what the subject does.
- "dossier": the quoted passages under their source addresses, as written.
- "sources": every address the write-up cites, in the order it first cites them.`;

// ── The wall clock ────────────────────────────────────────────────────────
//
// The contract promises at most three minutes per entry and, until now,
// nothing enforced it here — a production entry took eight and three quarter
// minutes and a morning run over twenty of them had no ceiling at all.
//
// The deadline covers the WHOLE engine — the profile pre-read, the research
// turn and the filing call — because a caller waiting on an entry does not
// care which phase is slow. It ABORTS the streaming request rather than
// abandoning it: an abandoned turn goes on searching, reading and billing
// after nobody is waiting for its answer.

interface Deadline {
  /** Aborted the moment the clock runs out. */
  signal: AbortSignal;
  /** Resolves at the deadline, and never rejects. */
  expired: Promise<void>;
  /** Stops the timer, so a finished entry does not hold the process open. */
  cancel: () => void;
  /** The whole allowance, which is what the note reports. */
  totalMs: number;
}

function startDeadline(totalMs: number): Deadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, totalMs);
  });
  return { signal: controller.signal, expired, cancel: () => clearTimeout(timer), totalMs };
}

/** Whichever came first. A step that rejects reports its rejection rather
 *  than throwing it, so a step nobody is waiting for any more can never take
 *  the process down with an unhandled rejection after the deadline branch has
 *  already been taken. */
type Raced<T> = { value: T } | { error: unknown } | { expired: true };

function within<T>(work: Promise<T>, deadline: Deadline): Promise<Raced<T>> {
  const settled: Promise<Raced<T>> = work.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return Promise.race([settled, deadline.expired.then(() => ({ expired: true as const }))]);
}

function timedOutNote(deadline: Deadline): string {
  return `timed out after ${Math.round(deadline.totalMs / 1000)}s`;
}

/** An entry the clock ran out on before there was anything to file.
 *  `unmeasured` when a call was aborted mid-flight — its usage row never came
 *  back, so this record's numbers are missing rather than zero. */
function timedOut(args: {
  phase: string;
  deadline: Deadline;
  usage: ResearchUsage;
  name: string;
  run: Record<string, unknown>;
  unmeasured?: boolean;
}): ResearchResult {
  const { phase, deadline, usage, name, run, unmeasured = false } = args;
  logger.warn(`${LOG} the wall clock ran out during ${phase}`, {
    name,
    outcome: 'no_match',
    wallClockMs: deadline.totalMs,
    unmeasured,
    ...run,
  });
  return nothingFound('no_match', {
    ...usage,
    notes: [
      ...(usage.notes ?? []),
      timedOutNote(deadline),
      ...(unmeasured ? [USAGE_NOT_MEASURED] : []),
    ],
  });
}

// ── The page reader ───────────────────────────────────────────────────────
//
// Where Anthropic's hosted fetcher exists, the turn reads pages inside its own
// request and nothing here runs. Where it does not — Google serves no hosted
// web fetch — the model gets a client-side `web_fetch` tool with the same name,
// and this is what answers it: the same scraper the rest of the engine uses,
// with its own byte and character ceilings already applied.

/** Reads one page for the turn. A failure is returned rather than thrown, so
 *  the model is told the page would not open and can try another address —
 *  which is the whole difference between a dead end and a silent blank. */
async function scrapePage(url: string): Promise<PageFetchResult> {
  // The one host this engine does not read, on either reader. A scrape of
  // LinkedIn returns its login wall, which reads as a real page and is not
  // one; the profile the entry carried has already been read above.
  if (isLinkedInUrl(url)) return { error: 'linkedin.com cannot be read' };
  try {
    const text = await tools().scrape(url);
    return text.trim() ? { text } : { error: 'the page had no readable text' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The model's own searches, where the provider hosts none: the deployment's
 *  web search service, the same index the constrained engine searches. A
 *  failure is reported to the model rather than read as no results. */
async function searchWeb(query: string): Promise<WebSearchResult> {
  try {
    const found = await tools().search(query);
    return {
      hits: (found.items ?? []).flatMap((item) =>
        item.link ? [{ url: item.link, title: item.title ?? '', snippet: item.snippet ?? '' }] : [],
      ),
    };
  } catch (error) {
    return { error: describeError(error) };
  }
}

/** An entry that cannot be researched because this deployment's page fetcher
 *  is not configured. Named on the record rather than discovered one failed
 *  read at a time, and refused before anything is spent. */
function pageFetcherUnconfigured(args: {
  missing: string[];
  usage: ResearchUsage;
  name: string;
  run: Record<string, unknown>;
}): ResearchResult {
  const { missing, usage, name, run } = args;
  logger.warn(`${LOG} no page fetcher is configured on this route`, {
    name,
    outcome: 'fetch_failed',
    missing,
    ...run,
  });
  return nothingFound('fetch_failed', {
    ...usage,
    notes: [
      ...(usage.notes ?? []),
      `this route reads pages with our own fetcher, which is not configured — set ${missing.join(', ')}`,
    ],
  });
}

// ── The engine ────────────────────────────────────────────────────────────

export const agenticEngine: ResearchEngine = async (input, options) => {
  const started = Date.now();
  const { value, usage: modelUsage } = await meterAnthropicUsage(() => research(input, options));
  return {
    ...value,
    usage: {
      ...value.usage,
      modelCalls: modelUsage.calls,
      inputTokens: modelUsage.inputTokens,
      outputTokens: modelUsage.outputTokens,
      cacheReadTokens: modelUsage.cacheReadTokens,
      cacheCreationTokens: modelUsage.cacheCreationTokens,
      // The profile pre-read spends the same budget as the server tools do,
      // so it is ADDED to what the meter saw rather than overwritten by it.
      searches: modelUsage.searches + value.usage.searches,
      fetches: modelUsage.fetches + value.usage.fetches,
      wallClockMs: Date.now() - started,
    },
  };
};

async function research(
  input: ResearchInput,
  options: ResearchOptions | undefined,
): Promise<ResearchResult> {
  const budget = budgetOf(options);
  const deadline = startDeadline(budget.wallClockMs);
  try {
    return await researchWithin(input, options, budget, deadline);
  } finally {
    deadline.cancel();
  }
}

async function researchWithin(
  input: ResearchInput,
  options: ResearchOptions | undefined,
  budget: ResearchBudget,
  deadline: Deadline,
): Promise<ResearchResult> {
  const run = runFields();
  const model = options?.model ?? DEFAULT_RESEARCH_MODEL;
  const usage: ResearchUsage = emptyUsage();
  const name = input.name.trim();

  // Before any spend: a turn told it has a page reader, on a deployment where
  // nothing can answer one, would discover that one failed read at a time and
  // report it as a subject with no signal.
  const pageReader = defaultPageReader(resolveModel(model).provider);
  const missingFetcher = pageReader === 'own' ? tools().missingScraperSettings() : [];
  if (missingFetcher.length > 0) {
    return pageFetcherUnconfigured({ missing: missingFetcher, usage, name, run });
  }

  // `web_fetch` opens only an address already in the conversation, so the
  // entry's own links have to be in the prompt to be readable at all.
  const urls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);

  // The one address this engine cannot open. Anthropic's server fetcher
  // refuses linkedin.com (`url_not_allowed`), so a turn handed a profile
  // address is blind to exactly the page that would settle who it is
  // researching. It is read here instead, with the constrained engine's own
  // primitives and its own caps, and handed to the turn as material it
  // already has. A company page is not a profile and gets none of this.
  const slug = urls.map((url) => profileSlug(url)).find((s): s is string => s != null);
  let profile: ProfileRead | null = null;
  if (slug) {
    const preRead = await within(preReadProfile({ slug, usage, budget, run }), deadline);
    if ('expired' in preRead) {
      return timedOut({ phase: 'the profile pre-read', deadline, usage, name, run });
    }
    if ('error' in preRead) throw preRead.error;
    profile = preRead.value;
  }

  const userMessage = [
    // An entry can arrive as an address and nothing else — a profile with no
    // name beside it — and then the address is the whole identity.
    name ? `Subject: ${name}` : 'Subject: not named — the entry carried only an address, so whoever holds it IS the subject.',
    input.context?.trim() ? `What the message said about it: ${input.context.trim()}` : null,
    urls.length
      ? `Addresses the message carried (read these first):\n${urls.map((u) => `- ${u}`).join('\n')}`
      : 'The message carried no addresses.',
    profile ? `THE PROFILE, AS READ:\n${describeProfile(profile)}` : null,
    `What the caller wants to know: ${input.questions?.trim() || 'what it is and what it does'}`,
  ]
    .filter((part): part is string => part != null)
    .join('\n');

  // The engine's own allowance, inside the shared ceiling — the smaller of
  // what it is entitled to and what the pre-read left of the entry's budget.
  const effort = options?.effort ?? configuredEffort();
  const maxSearches = Math.min(
    allowanceFrom(process.env.RESEARCH_AGENTIC_SEARCHES, DEFAULT_AGENTIC_SEARCHES),
    Math.max(0, budget.maxSearches - usage.searches),
  );
  const maxFetches = Math.min(
    allowanceFrom(process.env.RESEARCH_AGENTIC_FETCHES, DEFAULT_AGENTIC_FETCHES),
    Math.max(0, budget.maxFetches - usage.fetches),
  );
  // What this entry was actually given, on the record — a run whose answers
  // got worse should never leave you guessing what it was allowed to spend.
  logger.info(`${LOG} the turn's allowance`, {
    name,
    maxSearches,
    maxFetches,
    pageReader,
    effort,
    wallClockMs: budget.wallClockMs,
    ...run,
  });

  const called = await within(
    anthropicWebChat({
      system: RESEARCH_SYSTEM,
      userMessage,
      model,
      effort,
      maxSearches,
      maxFetches,
      pageReader,
      fetchPage: scrapePage,
      searchWeb,
      signal: deadline.signal,
      label: 'plugin_research_agentic',
    }),
    deadline,
  );
  if ('expired' in called) {
    // The stream was aborted mid-flight, so its usage row never came back:
    // this entry's tokens, searches and cost are MISSING, not zero.
    return timedOut({ phase: 'the research turn', deadline, usage, name, run, unmeasured: true });
  }
  if ('error' in called) {
    logger.warn(`${LOG} The research turn failed`, {
      name,
      error: describeError(called.error),
      ...run,
    });
    return nothingFound('no_match', usage);
  }
  const reply = called.value;

  // A tool that could not run is not a subject with no signal — the two look
  // identical in the answer, so the failures are named on the run record.
  const failures = reply.events.filter((e) => e.kind === 'search_failed' || e.kind === 'fetch_failed');
  const fetchFailed = reply.events.some((e) => e.kind === 'fetch_failed');
  if (failures.length) {
    logger.warn(`${LOG} A server tool failed`, {
      name,
      failures: failures.map(describeFailure),
      ...run,
    });
  }

  if (!reply.text.trim()) {
    logger.info(`${LOG} The research turn wrote nothing`, {
      name,
      stopReason: reply.stopReason,
      resumes: reply.resumes,
      ...run,
    });
    return nothingFound(outcomeOf({ answered: 'none', fetchFailed }), usage);
  }

  // Everything the turn actually opened, in the order it opened it — the
  // model's own citation list is what it MEANT to cite, which is not the same
  // list and is the one that goes stale.
  const visited = reply.events.flatMap((e) =>
    e.kind === 'fetch' ? [e.url] : e.kind === 'search' ? e.results.map((r) => r.url) : [],
  );

  // The clock is allowed to run out here too, and this is the one place where
  // that is not a failure: the research is DONE, and only the clerical call
  // that files it into fields is still running. It takes the same road a
  // shaping failure takes — the raw write-up, filed low-confidence.
  const shaped = filingOutcome(
    await within(shape({ writeUp: reply.text, model, run, name }), deadline),
    deadline,
  );

  // A finished write-up must never become `no_match` because the small call
  // that files it into fields choked — that call has nothing left to decide,
  // it is just clerical. File the write-up itself, flagged low-confidence,
  // and put the failure on the record rather than on the outcome.
  if ('failure' in shaped) {
    const outcome = outcomeOf({ answered: 'some', fetchFailed });
    usage.notes = [...(usage.notes ?? []), shaped.failure];
    if (fetchFailed) noteFetchFailure(usage, failures.map(describeFailure).join('; '));
    logger.warn(`${LOG} filed the raw write-up rather than the fields`, {
      name,
      outcome,
      reason: shaped.failure,
      ...run,
    });
    return {
      outcome,
      summary: reply.text.trim(),
      confidence: 'low',
      sources: dedupe(visited),
      usage,
    };
  }

  const filed = shaped.value;
  if (!filed.found || !filed.summary.trim()) {
    logger.info(`${LOG} nothing consistent`, { name, outcome: 'no_match', ...run });
    return nothingFound(outcomeOf({ answered: 'none', fetchFailed }), usage);
  }

  const answered: AnsweredExtent = filed.answers_everything ? 'all' : 'some';
  const outcome = outcomeOf({ answered, fetchFailed });
  if (fetchFailed) {
    noteFetchFailure(usage, failures.map(describeFailure).join('; '));
    logger.info(`${LOG} a fetch failed alongside a real answer`, {
      name,
      outcome,
      failures: failures.map(describeFailure),
      ...run,
    });
  }

  const sources = dedupe([
    ...filed.sources.map((s) => s.trim()).filter(Boolean),
    ...(filed.sources.length === 0 ? visited : []),
  ]);

  const { summary, stripped } = stripVerificationOpener(filed.summary.trim());
  if (stripped) {
    usage.notes = [...(usage.notes ?? []), `dropped a verification opener: ${stripped}`];
    logger.info(`${LOG} dropped a verification opener`, { name, sentence: stripped, ...run });
  }

  logger.info(`${LOG} ${outcome}`, {
    name,
    outcome,
    confidence: filed.confidence,
    resumes: reply.resumes,
    searches: reply.usage.searches,
    fetches: reply.usage.fetches,
    ...run,
  });

  return {
    outcome,
    summary,
    confidence: filed.confidence,
    sources,
    ...(filed.website.trim() && filed.website.trim().toLowerCase() !== 'none'
      ? { website: filed.website.trim() }
      : {}),
    ...(linkedinOf(filed.linkedin, urls) ? { linkedin: linkedinOf(filed.linkedin, urls) } : {}),
    ...(filed.dossier.trim() ? { dossier: filed.dossier.trim() } : {}),
    usage,
  };
}

// ── The profile pre-read ──────────────────────────────────────────────────

/**
 * Read the profile before the turn starts, on the same terms the constrained
 * engine reads it on: the search index first, the profile service only when
 * the index is thin, and both counted against the entry's own budget so the
 * turn that follows has that much less to spend. This engine is agentic about
 * the web, not about LinkedIn — the one host it cannot reach is the one it
 * does not get to decide about.
 */
async function preReadProfile(args: {
  slug: string;
  usage: ResearchUsage;
  budget: ResearchBudget;
  run: Record<string, unknown>;
}): Promise<ProfileRead | null> {
  const { slug, usage, budget, run } = args;
  const search = async (query: string): Promise<SearchHit[]> => {
    if (usage.searches >= budget.maxSearches) return [];
    usage.searches += 1;
    return runSearch(query, LOG, run);
  };

  const read = await readProfile({ slug, search, log: LOG, run });
  if (read.text) usage.fetches += 1;
  return read;
}

// ── Shaping ───────────────────────────────────────────────────────────────

/** The forced call that files the write-up. Retried once with the rejection
 *  reason appended (`retryFiling` in `contract.ts`); only a failure on BOTH
 *  attempts is reported, and the caller files the raw write-up rather than
 *  discard it. */
async function shape(args: {
  writeUp: string;
  model: ChatModelName;
  name: string;
  run: Record<string, unknown>;
}): Promise<{ value: z.infer<typeof shapeSchema> } | { failure: string }> {
  const { writeUp, model, name, run } = args;
  return retryFiling({
    call: (userMessage) =>
      anthropicChatStructured({
        system: SHAPE_SYSTEM,
        userMessage,
        schema: shapeSchema,
        toolName: 'file_research',
        toolDescription: 'File this research write-up into its fields, unchanged.',
        model,
        maxTokens: 8192,
        label: 'plugin_research_agentic_shape',
      }),
    firstMessage: `The write-up:\n\n${writeUp}`,
    onFailure: (attempt, error) => {
      logger.warn(
        `${LOG} The write-up could not be filed${attempt === 1 ? '; retrying once' : ' on retry'}`,
        { name, error, ...run },
      );
    },
  });
}

type Shaped = z.infer<typeof shapeSchema>;

/** What the filing call left behind, in the two shapes the caller acts on.
 *  Every way of not getting fields back — the clock, a rejection, a call that
 *  failed twice — collapses to one `failure` note, because the caller does
 *  the same thing with all three: file the write-up raw. */
function filingOutcome(
  filing: Raced<{ value: Shaped } | { failure: string }>,
  deadline: Deadline,
): { value: Shaped } | { failure: string } {
  if ('expired' in filing) return { failure: timedOutNote(deadline) };
  if ('error' in filing) return { failure: `filing threw: ${describeError(filing.error)}` };
  if ('failure' in filing.value) {
    return { failure: `shaping failed after a retry: ${filing.value.failure}` };
  }
  return filing.value;
}

/** A profile address only counts if it IS one. The model is asked for the
 *  address it confirmed, and "none" and a company page are both non-answers. */
function linkedinOf(reported: string, urls: readonly string[]): string | undefined {
  const claimed = reported.trim();
  if (claimed && claimed.toLowerCase() !== 'none' && profileSlug(claimed)) return claimed;
  return urls.find((url) => profileSlug(url) != null);
}

function describeFailure(event: WebToolEvent): string {
  if (event.kind === 'search_failed') return `search "${event.query ?? '?'}": ${event.errorCode}`;
  if (event.kind === 'fetch_failed') return `fetch ${event.url ?? '?'}: ${event.errorCode}`;
  return event.kind;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
