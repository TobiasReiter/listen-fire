/**
 * Fixtures for the extraction model bake-off (`dev:extraction-bakeoff`).
 *
 * Each fixture is a SOURCE TEXT plus the extraction tree to run over it plus
 * the answers, written down. The answers are the point: recall and precision
 * are only mechanical if the right answer was fixed before the models ran, so
 * every fixture states its entities and their field values here, and the
 * scorer never looks at anything else.
 *
 * The transcripts are synthetic on purpose. Real Slack would make the numbers
 * unpublishable and unrepeatable; what a bake-off needs is a source whose
 * correct answer is not a matter of opinion.
 */
import type {
  ExprSlot,
  ExtractExpression,
  ExtractField,
  ExtractNode,
  ExtractStage,
  Span,
} from 'movement-lang';
import type { FieldType } from 'movement-lang';
import type { TransformInvocationResult } from 'movement-engine/services/movement_engine/extraction';

// ── AST builders ───────────────────────────────────────────────────────────
//
// The fixtures build the extract AST directly rather than parsing a movement:
// the bake-off measures the MODEL against a fixed prompt, and going through
// the parser would let a language change silently move the prompt underneath
// a comparison between two runs.

const SPAN: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

/** A description slot spelled exactly as the parser would produce it — the
 *  quoted literal, escapes and all — so a fixture goes through the same
 *  string desugaring a written movement does. */
function descriptionSlot(text: string): ExprSlot {
  return { raw: JSON.stringify(text), span: SPAN };
}

function field(name: string, description: string, type?: string): ExtractField {
  return {
    name,
    description: descriptionSlot(description),
    ...(type !== undefined ? { type } : {}),
    span: SPAN,
  };
}

function stage(
  fields: ExtractField[],
  children: ExtractNode[] = [],
  through?: string[],
): ExtractStage {
  return {
    fields,
    children,
    ...(through ? { through: through.map((plugin) => ({ plugin, args: [], span: SPAN })) } : {}),
    span: SPAN,
  };
}

function node(name: string, description: string, stages: ExtractStage[]): ExtractNode {
  return { name, description: descriptionSlot(description), stages, span: SPAN };
}

function extract(stages: ExtractStage[]): ExtractExpression {
  return { from: [{ raw: 'source', span: SPAN }], stages, span: SPAN };
}

// ── The closed set ─────────────────────────────────────────────────────────

/**
 * The fund's thesis areas, as a written refinement (`type Thesis = <…>`). The
 * bake-off's "did the closed set hold" question is asked of this: a value
 * outside it is a refinement the model broke, and the engine's coercion
 * tracker records it rather than letting it through.
 */
export const THESES = ['fintech', 'climate', 'devtools', 'healthcare', 'consumer'] as const;

/** Funding stages, the second closed set — reached only through enrichment. */
export const STAGES = ['pre-seed', 'seed', 'series-a', 'series-b', 'growth'] as const;

const DECLARED_TYPES: Record<string, FieldType> = {
  Thesis: { kind: 'enum', options: [...THESES] },
  FundingStage: { kind: 'enum', options: [...STAGES] },
};

export function resolveDeclaredType(name: string): FieldType | undefined {
  return DECLARED_TYPES[name];
}

// ── Expected answers ───────────────────────────────────────────────────────

export interface ExpectedEntity {
  /** The identity field's value — how an extracted entity is matched to this
   *  one. Matching is normalised (case, whitespace, trailing punctuation) and
   *  otherwise exact: two companies one word apart are two companies. */
  key: string;
  /** Field name → the one right answer. `null` means the source genuinely
   *  lacks it and a value there is an invention. */
  fields: Record<string, string | number | null>;
  children?: Record<string, ExpectedNode>;
}

export interface ExpectedNode {
  /** Which field identifies an entity of this node. */
  identity: string;
  entities: ExpectedEntity[];
  /** Fields whose value must come from a written closed set. */
  closed?: Record<string, readonly string[]>;
}

export interface Fixture {
  id: string;
  title: string;
  /** One line on what this fixture is asking of the model. */
  asks: string;
  source: string;
  extract: ExtractExpression;
  /** Node name → what the root's children should be. Every fixture here puts
   *  its entities under exactly one child node of the root. */
  expected: Record<string, ExpectedNode>;
  /** Fixed enrichment, keyed by plugin then by the entity's identity value.
   *  Present only on the two-stage fixture — the bake-off measures the model,
   *  so nothing here goes near a network. */
  enrichment?: Record<string, Record<string, TransformInvocationResult>>;
}

// ── Shared shapes ──────────────────────────────────────────────────────────

const COMPANY_FIELDS = [
  field('name', "the company's name, exactly as written"),
  field('website', "the company's website URL, exactly as it appears in the source"),
  field('thesis', 'which of the fund’s thesis areas this company falls under', 'Thesis'),
  // The honorific is spelled out because otherwise it is not a right answer,
  // it is a coin toss: the models split on whether "Dr." is part of a full
  // name, and a scorer cannot mark a coin toss.
  field(
    'contact',
    'the full name of the person AT THIS COMPANY who was named, with no title or honorific',
  ),
];

function companyTree(): ExtractExpression {
  return extract([
    stage(
      [],
      [node('company', 'each company discussed as a potential investment', [stage(COMPANY_FIELDS)])],
    ),
  ]);
}

// ── Filler ─────────────────────────────────────────────────────────────────

/**
 * Entity-free chatter, deterministic so two runs read the same source. The
 * long fixture is a needle-in-a-haystack test and the haystack has to be real
 * volume, not a repeated line the model can collapse.
 */
const CHATTER = [
  'can we push standup to 10:15, dentist',
  'the offsite doc is in the shared drive, comments open until friday',
  'reminder that expenses for last month close tomorrow',
  'whoever has the good HDMI adapter please return it to the drawer',
  'lunch order going in at 12, reply with what you want',
  'the wifi in the small room is flaky again, IT has a ticket',
  'I will be out thursday afternoon, back friday',
  'moved the pipeline review to next tuesday, calendar updated',
  'does anyone still have the printed copy of the LP letter',
  'coffee machine descaled, it should stop making that noise',
  'parking garage is closed saturday for resurfacing',
  'new laptops arrive next week, IT will do the swap desk by desk',
  'the fire drill is at 3 today, nothing to prepare',
  'please fill in the travel survey before end of week',
  'the shared calendar had a duplicate, I deleted the second one',
  'reception has a package for whoever ordered the standing desk mat',
];

const SPEAKERS = ['maya', 'tomas', 'priya', 'dan', 'ines', 'olu', 'greta', 'sam'];

function filler(count: number, offset = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = i + offset;
    lines.push(`${SPEAKERS[n % SPEAKERS.length]}: ${CHATTER[n % CHATTER.length]}`);
  }
  return lines.join('\n');
}

// ── F1 — a short transcript ────────────────────────────────────────────────

const SMALL_SOURCE = `#dealflow

maya: two things came out of the Berlin trip worth writing up.
maya: first is Loambank — https://loambank.eu — they do treasury sweep for small banks, so squarely fintech for us. Their CEO is Astrid Køhler and she's the one who'd run the process.
tomas: I liked Loambank. Rev is small but the pipeline was real.
maya: second is Fernwater (https://fernwater.io). Grid-scale heat storage, very much a climate bet. We met Rajesh Manoharan, who is CTO and effectively the founder.
priya: noting that Fernwater has no revenue yet, purely pre-product.
tomas: agreed on both. I'll open the files.
maya: one more mention — Karl Beck from the Aurum fund was on the same panel, but that's not a company, just a co-investor.
`;

const F1: Fixture = {
  id: 'slack_small',
  title: 'Short transcript — 2 companies',
  asks: 'the floor: can the model read two obvious entities out of one screen of text',
  source: SMALL_SOURCE,
  extract: companyTree(),
  expected: {
    company: {
      identity: 'name',
      closed: { thesis: THESES },
      entities: [
        {
          key: 'Loambank',
          fields: {
            name: 'Loambank',
            website: 'https://loambank.eu',
            thesis: 'fintech',
            contact: 'Astrid Køhler',
          },
        },
        {
          key: 'Fernwater',
          fields: {
            name: 'Fernwater',
            website: 'https://fernwater.io',
            thesis: 'climate',
            contact: 'Rajesh Manoharan',
          },
        },
      ],
    },
  },
};

// ── F2 — a mid-length transcript ───────────────────────────────────────────

const MID_SOURCE = `#dealflow

${filler(16)}

priya: kicking off the weekly. Four new things since last time.
priya: 1. Halberd Systems, https://halberd.systems — CI runners on bare metal, developer tooling all the way down. Founder is Wren Okonjo, ex-Stripe infra.
dan: Halberd's numbers were the best of the four. Wren was sharp.
priya: 2. Cassava Health (https://cassavahealth.com). Remote titration for hypertension, so healthcare. The person we met was Dr. Ngozi Adeyemi.
${filler(12, 16)}
dan: on Cassava — the clinical evidence is thinner than the deck suggests, flagging it.
priya: 3. Sootless, https://sootless.co — retrofit heat pumps for terraced housing. Climate, obviously. Their COO Bram de Vries ran the meeting; the CEO was travelling.
ines: Sootless has a waiting list which is a nice signal.
priya: 4. Tallow & Co (https://tallowand.co) — direct-to-consumer skincare, so a consumer deal. We spoke to Marguerite Fell, who founded it.
${filler(14, 28)}
dan: for the record, Halberd's website is halberd.systems not halberd.dev, someone had it wrong in the notes.
priya: also mentioned but not a company: the Northaven Foundation, who intro'd us to Cassava.
ines: and Peter Lund at Ridgeline is a co-investor on Sootless, not part of the company.
${filler(16, 42)}
`;

const F2: Fixture = {
  id: 'slack_mid',
  title: 'Mid transcript — 4 companies among chatter',
  asks: 'four entities with distractors: a co-investor, a foundation, a corrected URL',
  source: MID_SOURCE,
  extract: companyTree(),
  expected: {
    company: {
      identity: 'name',
      closed: { thesis: THESES },
      entities: [
        {
          key: 'Halberd Systems',
          fields: {
            name: 'Halberd Systems',
            website: 'https://halberd.systems',
            thesis: 'devtools',
            contact: 'Wren Okonjo',
          },
        },
        {
          key: 'Cassava Health',
          fields: {
            name: 'Cassava Health',
            website: 'https://cassavahealth.com',
            thesis: 'healthcare',
            contact: 'Ngozi Adeyemi',
          },
        },
        {
          key: 'Sootless',
          fields: {
            name: 'Sootless',
            website: 'https://sootless.co',
            thesis: 'climate',
            contact: 'Bram de Vries',
          },
        },
        {
          key: 'Tallow & Co',
          fields: {
            name: 'Tallow & Co',
            website: 'https://tallowand.co',
            thesis: 'consumer',
            contact: 'Marguerite Fell',
          },
        },
      ],
    },
  },
};

// ── F3 — a long transcript ─────────────────────────────────────────────────

const LONG_SOURCE = [
  '#dealflow — quarter in review',
  '',
  filler(52),
  '',
  'olu: writing up the six we actually progressed this quarter, in order.',
  'olu: Pellucid Ledger (https://pellucidledger.com) — reconciliation for multi-entity groups. Fintech. Founder and CEO is Iolanda Ferreira.',
  filler(40, 52),
  'greta: Pellucid was the cleanest data room I have seen this year.',
  '',
  'olu: Kelpwright, https://kelpwright.org — kelp sequestration with a measurement layer. Climate. We dealt with Sunniva Aas, who is head of science and a co-founder.',
  filler(38, 92),
  'sam: Kelpwright is early but the measurement work is the moat.',
  '',
  'olu: Brambleport (https://brambleport.dev) — an artifact registry that is actually fast. Devtools. Their founder is Casimir Nowak.',
  filler(36, 130),
  '',
  'olu: Vellichor Care, https://vellichorcare.com — care coordination for post-surgical discharge, healthcare. Dr. Amara Osei-Bonsu is the clinical founder.',
  filler(40, 166),
  'greta: Vellichor’s pilot hospital renewed, which is the thing that matters.',
  '',
  'olu: Quillon Foods (https://quillonfoods.com) — shelf-stable meals with a real brand. Consumer. We met Hector Salvatierra, the CEO.',
  filler(36, 206),
  '',
  'olu: Ashgrove Compute, https://ashgrove.computer — scheduling layer for GPU fleets. Devtools. Founder is Theodora Lindqvist.',
  filler(44, 242),
  'sam: for completeness — Marrow Capital and the Delfino Trust both appear in these threads as LPs or co-investors, not as companies.',
  filler(30, 286),
].join('\n');

const F3: Fixture = {
  id: 'slack_long',
  title: 'Long transcript — 6 companies in ~20k chars of chatter',
  asks: 'does recall survive a long, noisy input',
  source: LONG_SOURCE,
  extract: companyTree(),
  expected: {
    company: {
      identity: 'name',
      closed: { thesis: THESES },
      entities: [
        {
          key: 'Pellucid Ledger',
          fields: {
            name: 'Pellucid Ledger',
            website: 'https://pellucidledger.com',
            thesis: 'fintech',
            contact: 'Iolanda Ferreira',
          },
        },
        {
          key: 'Kelpwright',
          fields: {
            name: 'Kelpwright',
            website: 'https://kelpwright.org',
            thesis: 'climate',
            contact: 'Sunniva Aas',
          },
        },
        {
          key: 'Brambleport',
          fields: {
            name: 'Brambleport',
            website: 'https://brambleport.dev',
            thesis: 'devtools',
            contact: 'Casimir Nowak',
          },
        },
        {
          key: 'Vellichor Care',
          fields: {
            name: 'Vellichor Care',
            website: 'https://vellichorcare.com',
            thesis: 'healthcare',
            contact: 'Amara Osei-Bonsu',
          },
        },
        {
          key: 'Quillon Foods',
          fields: {
            name: 'Quillon Foods',
            website: 'https://quillonfoods.com',
            thesis: 'consumer',
            contact: 'Hector Salvatierra',
          },
        },
        {
          key: 'Ashgrove Compute',
          fields: {
            name: 'Ashgrove Compute',
            website: 'https://ashgrove.computer',
            thesis: 'devtools',
            contact: 'Theodora Lindqvist',
          },
        },
      ],
    },
  },
};

// ── F4 — a nested tree ─────────────────────────────────────────────────────

const NESTED_SOURCE = `#intros

ines: three companies came through the accelerator demo day, each with the people we met.

ines: Marrowlight (https://marrowlight.ai). Team: Ola Bergström is CEO, Farida Haddad is CTO.
ines: Coppice Grid, https://coppicegrid.com — Lena Vogt is the founder and only full-timer.
ines: Sablefish Labs (https://sablefish.bio). We met Yusuf Kaya, who is CEO, and Ruth Ellery, their head of chemistry.
ines: the accelerator's own partner, Nils Ahlberg, was in all three meetings — he is not on any of these teams.
`;

const F4: Fixture = {
  id: 'nested_tree',
  title: 'Nested tree — companies with their people',
  asks: 'does the nested-array shape hold, and does the distractor person stay out of every team',
  source: NESTED_SOURCE,
  extract: extract([
    stage(
      [],
      [
        node('company', 'each company introduced at the demo day', [
          stage(
            [
              field('name', "the company's name, exactly as written"),
              field('website', "the company's website URL, exactly as it appears"),
            ],
            [
              node('person', 'each person who works AT THIS COMPANY', [
                stage([
                  field('name', "the person's full name"),
                  field('role', 'their role at this company, lowercased'),
                ]),
              ]),
            ],
          ),
        ]),
      ],
    ),
  ]),
  expected: {
    company: {
      identity: 'name',
      entities: [
        {
          key: 'Marrowlight',
          fields: { name: 'Marrowlight', website: 'https://marrowlight.ai' },
          children: {
            person: {
              identity: 'name',
              entities: [
                { key: 'Ola Bergström', fields: { name: 'Ola Bergström', role: 'ceo' } },
                { key: 'Farida Haddad', fields: { name: 'Farida Haddad', role: 'cto' } },
              ],
            },
          },
        },
        {
          key: 'Coppice Grid',
          fields: { name: 'Coppice Grid', website: 'https://coppicegrid.com' },
          children: {
            person: {
              identity: 'name',
              entities: [{ key: 'Lena Vogt', fields: { name: 'Lena Vogt', role: 'founder' } }],
            },
          },
        },
        {
          key: 'Sablefish Labs',
          fields: { name: 'Sablefish Labs', website: 'https://sablefish.bio' },
          children: {
            person: {
              identity: 'name',
              entities: [
                { key: 'Yusuf Kaya', fields: { name: 'Yusuf Kaya', role: 'ceo' } },
                {
                  key: 'Ruth Ellery',
                  fields: { name: 'Ruth Ellery', role: 'head of chemistry' },
                },
              ],
            },
          },
        },
      ],
    },
  },
};

// ── F5 — the two-stage recap ───────────────────────────────────────────────

const RECAP_SOURCE = `#dealflow

dan: two to write up from today.
dan: Ambergrove (https://ambergrove.com) — payments orchestration. Fintech.
dan: Thornwick Energy, https://thornwick.energy — long-duration storage. Climate.
dan: I'll pull the dossiers for both before we decide.
`;

/**
 * What the through-stage's plugin "fetched" — fixed text, no network. The
 * shape is what matters: the second stage answers from a block of prose the
 * first stage's entity never saw, which is the recap's whole mechanic.
 */
const RECAP_DOSSIERS: Record<string, TransformInvocationResult> = {
  Ambergrove: {
    text: [
      'Ambergrove — company dossier',
      'Ambergrove closed a $14m round in March led by Kestrel Partners. The round was',
      'their Series A; a $3m seed preceded it in 2024. Headcount at close was 41 people,',
      'up from 12 a year earlier. Gross revenue run-rate was reported at $6.2m.',
    ].join('\n'),
  },
  'Thornwick Energy': {
    text: [
      'Thornwick Energy — company dossier',
      'Thornwick raised a pre-seed of $1.1m in late 2025 and has not raised since. The',
      'company is 7 people, all in Rotterdam, and has no revenue; the first pilot is',
      'scheduled for next year with a regional utility.',
    ].join('\n'),
  },
};

const F5: Fixture = {
  id: 'recap_two_stage',
  title: 'Two-stage recap — declared refinement filled from enrichment',
  asks: 'does the per-entity continuation call read the enrichment block and hold the closed set',
  source: RECAP_SOURCE,
  extract: extract([
    stage(
      [],
      [
        node('company', 'each company discussed as a potential investment', [
          stage([
            field('name', "the company's name, exactly as written"),
            field('website', "the company's website URL, exactly as it appears"),
          ]),
          stage(
            [
              field(
                'stage',
                'the funding stage of this company’s most recent round',
                'FundingStage',
              ),
              field('headcount', 'the number of people at this company', 'number'),
            ],
            [],
            ['bakeoff_dossier'],
          ),
        ]),
      ],
    ),
  ]),
  enrichment: { bakeoff_dossier: RECAP_DOSSIERS },
  expected: {
    company: {
      identity: 'name',
      closed: { stage: STAGES },
      entities: [
        {
          key: 'Ambergrove',
          fields: {
            name: 'Ambergrove',
            website: 'https://ambergrove.com',
            stage: 'series-a',
            headcount: 41,
          },
        },
        {
          key: 'Thornwick Energy',
          fields: {
            name: 'Thornwick Energy',
            website: 'https://thornwick.energy',
            stage: 'pre-seed',
            headcount: 7,
          },
        },
      ],
    },
  },
};

// ── F6 — the adversarial near-duplicates ───────────────────────────────────

const SIMILAR_SOURCE = `#dealflow-confusing

sam: heads up, there are FOUR separate things with almost the same name and they are not related.

sam: Acme Robotics (https://acmerobotics.com) — warehouse picking arms, based in Ohio. Founder Dale Whitmore. Devtools is wrong for them; call it consumer, they sell to retailers direct.
sam: Acme Robotic Systems, https://acme-robotic-systems.de — a German industrial integrator. Contact is Ute Brenner. Climate work, they retrofit factory heat recovery.
sam: ACME Robotics GmbH (https://acmerobotics.de) — no relation to either of the above, despite the name. Payments hardware, so fintech. Contact Lars Petersen.
sam: Acme Robotix (https://acmerobotix.io) — surgical assistance, healthcare. Contact Dr. Nadia Farouk.

sam: to be extremely clear: four companies, four different websites, four different people.
`;

const F6: Fixture = {
  id: 'adversarial_similar',
  title: 'Adversarial — four near-identical names',
  asks: 'does the model keep four confusable entities apart, or merge/duplicate them',
  source: SIMILAR_SOURCE,
  extract: companyTree(),
  expected: {
    company: {
      identity: 'name',
      closed: { thesis: THESES },
      entities: [
        {
          key: 'Acme Robotics',
          fields: {
            name: 'Acme Robotics',
            website: 'https://acmerobotics.com',
            thesis: 'consumer',
            contact: 'Dale Whitmore',
          },
        },
        {
          key: 'Acme Robotic Systems',
          fields: {
            name: 'Acme Robotic Systems',
            website: 'https://acme-robotic-systems.de',
            thesis: 'climate',
            contact: 'Ute Brenner',
          },
        },
        {
          key: 'ACME Robotics GmbH',
          fields: {
            name: 'ACME Robotics GmbH',
            website: 'https://acmerobotics.de',
            thesis: 'fintech',
            contact: 'Lars Petersen',
          },
        },
        {
          key: 'Acme Robotix',
          fields: {
            name: 'Acme Robotix',
            website: 'https://acmerobotix.io',
            thesis: 'healthcare',
            contact: 'Nadia Farouk',
          },
        },
      ],
    },
  },
};

// ── F7 — the bare link ─────────────────────────────────────────────────────

const BARE_LINK_SOURCE = `https://vaultridge-partners-holdings.example/x/9f2\n`;

const F7: Fixture = {
  id: 'adversarial_bare_link',
  title: 'Adversarial — a bare link, no context',
  asks: 'the flag case: does the model say nothing, or invent a company out of a domain name',
  source: BARE_LINK_SOURCE,
  extract: companyTree(),
  // Nothing in the source says a company exists — the guide permits zero
  // entities, and zero is the right answer. Any entity here is an invention.
  expected: { company: { identity: 'name', closed: { thesis: THESES }, entities: [] } },
};

// ── H1 — the reconciliation transcript ─────────────────────────────────────
//
// Round 1's seven fixtures all scored 100% for sonnet-5, so none of them can
// show one model beating another: a ceiling measures nothing. The two H
// fixtures exist to break that ceiling, and they do it the only honest way —
// by asking questions whose right answer is not visible in any one place.
//
// Here that means a thread that CORRECTS ITSELF. Every field's answer is
// stated plainly somewhere; what is hard is that the first statement is often
// wrong by the end, and the message that overturns it is thousands of
// characters away. A model that reads locally and answers from the nearest
// supporting quote gets a well-formed, entirely wrong tree.

const RECONCILE_FIELDS = [
  field(
    'name',
    "the company's name as it stands at the END of the thread — where the thread says a company renamed or rebranded, the new name is the answer and the old name is not a separate company",
  ),
  field(
    'website',
    "the company's website URL as it stands at the END of the thread, exactly as written; where a later message replaces or corrects an earlier URL, the later one is the answer",
  ),
  field(
    'thesis',
    "which of the fund's thesis areas this company falls under, according to the LAST thing the thread says about it",
    'Thesis',
  ),
  field(
    'contact',
    'the full name, with no title or honorific, of the person AT THIS COMPANY who is our contact at the END of the thread. Someone who has left this company, or who never worked there, is not the answer',
  ),
  field('headcount', 'the most recently stated number of PEOPLE at this company', 'number'),
];

// Two calibration rounds are baked into the shape of this fixture, and both are
// findings in their own right.
//
// ROUND 1 of calibration put every correction in one tidy "housekeeping" block
// near the end. Sonnet-5 at effort `high` scored 100%: once you are reading a
// list of corrections, you know to apply them. So the amendments were scattered
// — each one thousands of characters from the claim it overturns and from every
// other amendment — and harder shapes were added: a second rename on top of the
// first, a "company" that turns out to be another company's product, an
// amendment that is not one, and a headcount whose restatement is itself
// corrected.
//
// ROUND 2 scored 100% too. Comprehension is not the binding constraint, so the
// last lever is VOLUME: eleven companies rather than six, every one of them
// carrying at least one amendment, none of them adjacent to its own. What that
// asks for is bookkeeping across ~30k characters, which is a different faculty
// from reading a passage correctly.

/** One company as it is first written up, and the amendments that land later.
 *  Kept apart so the transcript can interleave them at a distance rather than
 *  narrating each company in one place. */
const RECONCILE_INTROS = [
  'maya: Nettleford — https://nettleford.io — reconciliation tooling for mid-size insurers. Fintech. CEO is Ivo Kranz. 22 people.',
  'tomas: Quillhaven (https://quillhaven.com) — payments orchestration for marketplaces, so fintech. Founder is Sana Mehr. 14 people today.',
  'priya: Marbleyard, https://marbleyard.co — soil carbon MRV. Climate. Our contact is Hallie Ovesen. 8 people.',
  'dan: the Lisbon one from last week is worth a second look — logistics scheduling with a developer-first API. Marta Rebelo walked us through the deck.',
  'ines: Halvard Grain (https://halvardgrain.com) — ancient-grain cereals. Contact Ondine Pak. They have 40 SKUs and 9 employees.',
  'ines: I would book Halvard Grain as consumer.',
  'dan: disagree — Halvard Grain is really a supply-chain play, put them under devtools.',
  'olu: adding one: Kestrelift (https://kestrelift.app) — scheduling for field teams, devtools. Contact is Bo Lindqvist.',
  'greta: Sunderfell (https://sunderfell.dev) — incident replay for on-call teams, devtools. Contact Aoife Brennan, 15 people.',
  'sam: Pargeter Labs, https://pargeterlabs.com — bench automation for pathology, healthcare. Contact is Dr. Yannick Obi. 31 people.',
  'priya: Thackery Row — small-batch tinned fish, consumer. Contact Colm Devereux, 6 people. They are pre-launch.',
  'olu: Vasterling Energy (https://vasterling.energy) — flexibility markets, climate. Contact Ida Sjöberg, 44 people.',
  'tomas: Ombersley (https://ombersley.co.uk) — embedded lending for trade suppliers, fintech. Contact Priya Nandi, 21 people.',
];

const RECONCILE_AMENDMENTS = [
  'maya: Nettleford is trading as Ostrel from this month. New site https://ostrel.io.',
  'tomas: Quillhaven pivoted after the seed — the product is carbon accounting for marketplaces now, so they are a climate deal, not fintech.',
  'priya: is Marbleyard Bio the same company as Marbleyard? the names are almost identical.',
  'greta: no. Marbleyard Bio, https://marbleyardbio.com, is a separate company — enzymatic diagnostics, healthcare. Contact is Dr. Petra Solheim, 26 people. No relation to Marbleyard, no shared cap table, no shared investors.',
  'sam: Sunderfell — sunderfell.dev is a parked page they never moved off. The real site is https://sunderfell.io.',
  'dan: for the record the Lisbon company is Corvid Freight, https://corvidfreight.eu. Devtools. 12 people at the time we met.',
  'greta: Pargeter Labs shrank after the reorg — 28 people now.',
  "dan: and the Corvid Freight contact is Tiago Vasconcelos, not Marta Rebelo — Marta is the investor who intro'd us, she does not work there.",
  'maya: settling the Halvard Grain question — ines is right, they are a consumer deal. Booking it that way.',
  'sam: Pargeter Labs — Yannick Obi left in June. Our contact there is Rosa Iglesias now.',
  'olu: withdrawing Kestrelift. It is not a company, it is Corvid Freight’s product; Bo Lindqvist is Corvid’s head of product. My mistake.',
  'maya: Ivo Kranz has left Ostrel. Beatriz Amaral, who was COO, is CEO there now and is who we deal with.',
  'priya: Thackery Row still have no website — nothing to put in that column until they launch.',
  'maya: and Ivo has gone to Quillhaven. Sana Mehr moves to their board; Ivo is CEO from next month and is our contact there now.',
  'olu: headcount off the Ostrel operating update: 31.',
  'olu: Vasterling Energy reads like a software deal on the numbers, but the thesis stands — they are climate and I am not changing it.',
  'olu: Quillhaven are 19 after the two hires. Marbleyard unchanged at 8. Sunderfell unchanged at 15.',
  'tomas: Ombersley — the 21 counted contractors. Permanent headcount is 16, and 16 is the number we use.',
  'olu: Corvid Freight 17.',
  'sam: heads up, ostrel.io bounces now — the trademark letter forced another change. They are Ostralis, https://ostralis.io, as of last week. Same company, same people.',
  'olu: correction on Corvid — the 17 was the Lisbon office only. Company-wide they are 24.',
  'olu: Vasterling are 44 still, no change since the intro.',
  'ines: Halvard Grain is up to 13 people.',
  'sam: Ridgeback Capital and the Delvaux Trust both show up in this thread as co-investors and LPs. Neither is a company we are looking at.',
];

/** The transcript: every write-up, then every amendment, each separated from
 *  the next by a slab of chatter so no answer sits near the claim it replaces. */
function reconcileTranscript(): string {
  const lines = [
    '#dealflow — running thread, this quarter',
    '',
    filler(14),
    '',
    'maya: everything live, in the order it happened. I amend in place as things move, so read to the end before acting on any of it.',
    '',
  ];
  let offset = 14;
  for (const message of [...RECONCILE_INTROS, ...RECONCILE_AMENDMENTS]) {
    lines.push(message);
    const chunk = 12 + (offset % 5);
    lines.push(filler(chunk, offset));
    offset += chunk;
  }
  return lines.join('\n');
}

const RECONCILE_SOURCE = reconcileTranscript();

const H1: Fixture = {
  id: 'reconcile_long',
  title: 'Reconciliation — a self-correcting 30k-char thread',
  asks: 'can the model reconcile scattered, partly conflicting evidence: two successive renames of one company, a thesis argued then settled, a person moving between two of the companies, a near-duplicate name that is NOT the same company, a "company" that is another company’s product, and a headcount whose restatement is itself corrected',
  source: RECONCILE_SOURCE,
  extract: extract([
    stage([], [node('company', 'each company discussed as a potential investment', [stage(RECONCILE_FIELDS)])]),
  ]),
  expected: {
    company: {
      identity: 'name',
      closed: { thesis: THESES },
      entities: [
        {
          // Renamed TWICE — Nettleford → Ostrel → Ostralis — with the second
          // rename far from the first and phrased as a bouncing domain rather
          // than as a rename. Its founding CEO left for Quillhaven. Every field
          // is a later message overruling an earlier one.
          key: 'Ostralis',
          fields: {
            name: 'Ostralis',
            website: 'https://ostralis.io',
            thesis: 'fintech',
            contact: 'Beatriz Amaral',
            headcount: 31,
          },
        },
        {
          // Thesis corrected from fintech to climate; contact is the person who
          // arrived FROM Ostrel.
          key: 'Quillhaven',
          fields: {
            name: 'Quillhaven',
            website: 'https://quillhaven.com',
            thesis: 'climate',
            contact: 'Ivo Kranz',
            headcount: 19,
          },
        },
        {
          key: 'Marbleyard',
          fields: {
            name: 'Marbleyard',
            website: 'https://marbleyard.co',
            thesis: 'climate',
            contact: 'Hallie Ovesen',
            headcount: 8,
          },
        },
        {
          // The overlap trap: same stem, explicitly unrelated. Merging the two
          // costs an entity AND five fields.
          key: 'Marbleyard Bio',
          fields: {
            name: 'Marbleyard Bio',
            website: 'https://marbleyardbio.com',
            thesis: 'healthcare',
            contact: 'Petra Solheim',
            headcount: 26,
          },
        },
        {
          // Named only by codename ("the Lisbon one") where it is introduced;
          // its real name, URL and contact all arrive later, the person who
          // presented it is an investor rather than staff, and its headcount is
          // stated twice and corrected the second time. `Kestrelift` — pitched
          // as its own company and withdrawn later as this company's PRODUCT —
          // must not appear as a seventh entity, and its "contact" Bo Lindqvist
          // must not displace Tiago here.
          key: 'Corvid Freight',
          fields: {
            name: 'Corvid Freight',
            website: 'https://corvidfreight.eu',
            thesis: 'devtools',
            contact: 'Tiago Vasconcelos',
            headcount: 24,
          },
        },
        {
          // Two numbers in one early sentence, only one of which is people; and
          // a thesis two people disagree about until a third settles it.
          key: 'Halvard Grain',
          fields: {
            name: 'Halvard Grain',
            website: 'https://halvardgrain.com',
            thesis: 'consumer',
            contact: 'Ondine Pak',
            headcount: 13,
          },
        },
        {
          // Website replaced by one on a different TLD, with the old one
          // described as parked rather than as wrong.
          key: 'Sunderfell',
          fields: {
            name: 'Sunderfell',
            website: 'https://sunderfell.io',
            thesis: 'devtools',
            contact: 'Aoife Brennan',
            headcount: 15,
          },
        },
        {
          // Both the contact and the headcount move, in two amendments that are
          // nowhere near each other.
          key: 'Pargeter Labs',
          fields: {
            name: 'Pargeter Labs',
            website: 'https://pargeterlabs.com',
            thesis: 'healthcare',
            contact: 'Rosa Iglesias',
            headcount: 28,
          },
        },
        {
          // The genuine null. No URL is ever given, and a later message says so
          // outright — so a URL here is an invention, not a near miss.
          key: 'Thackery Row',
          fields: {
            name: 'Thackery Row',
            website: null,
            thesis: 'consumer',
            contact: 'Colm Devereux',
            headcount: 6,
          },
        },
        {
          // The amendment that is NOT one: a later message reconsiders the
          // thesis out loud and then leaves it alone, and a second restates the
          // headcount unchanged. A model applying every late message as a
          // correction gets both of these wrong.
          key: 'Vasterling Energy',
          fields: {
            name: 'Vasterling Energy',
            website: 'https://vasterling.energy',
            thesis: 'climate',
            contact: 'Ida Sjöberg',
            headcount: 44,
          },
        },
        {
          // The later number is SMALLER and is the right one — the reverse of
          // every other headcount amendment in the thread.
          key: 'Ombersley',
          fields: {
            name: 'Ombersley',
            website: 'https://ombersley.co.uk',
            thesis: 'fintech',
            contact: 'Priya Nandi',
            headcount: 16,
          },
        },
      ],
    },
  },
};

// ── H2 — the nested synthesis tree ─────────────────────────────────────────
//
// The second way a fixture can be hard: no single passage holds the answer
// because the answer does not appear anywhere. Every second-stage field here
// has to be COMPUTED from a first-stage field plus the enrichment block —
// which office is the headquarters, which round comes after which, cash over
// burn, and who holds the role a reference note names. The enrichment is
// written to reward the synthesis and punish the shortcut: the biggest office
// is never the HQ, the largest round is never the one named, and the obvious
// senior person is not always the one reported to.

// Calibration note. The first cut of this fixture stated each second-stage
// answer almost directly — one office number per city, one burn rate, one
// obvious prior employer — and sonnet-5 at effort `high` scored 100%. Each
// answer now needs one more step than reading: the headquarters city appears as
// two separate lines that must be summed, the burn rate that matters is the
// forward one rather than the one quoted first, the round to name is the most
// recent PRICED one, the most recent prior employer is the shortest and
// last-mentioned stint, and the person reported to is described by what they do
// rather than by their title. One reference note names no prior employer at
// all, against the pull of five that do — the null every other answer in the
// fixture argues against.
const SYNTHESIS_SOURCE = `#pipeline — Iberia trip

greta: three from the Iberia trip. A diligence dossier and a reference note per person follow for each.

greta: Sablewind (https://sablewind.energy) — grid balancing software for TSOs. Headquartered in Porto. Climate.
greta:   we met Nuno Cardoso, who is ceo, and Elif Yildiz, vp engineering.

greta: Pipthorn (https://pipthorn.io) — invoice financing for freight brokers. Fintech. The team is spread across Europe, but the registered office and the whole executive team sit in Madrid, which is where they are headquartered.
greta:   the two we spoke to were Aitana Ruiz, founder, and Kwame Boateng, head of credit.

greta: Larkmoor Bio (https://larkmoorbio.com) — assay automation for clinical labs. Headquartered in Barcelona. Healthcare.
greta:   Dr. Sigrid Halvorsen, chief scientific officer, and Tomas Neves, chief operating officer, presented.
greta:   Piotr Malinowski from Ridgeback Capital sat in on the Larkmoor session as well. He is their investor, not staff there.

greta: Ridgeback Capital is on two of these as a co-investor. Not a company we are looking at.
`;

/** Company dossiers — the second-stage evidence, fixed text, no network. */
const SYNTHESIS_PROFILES: Record<string, TransformInvocationResult> = {
  Sablewind: {
    text: [
      'Sablewind — diligence dossier',
      'Funding history: a €0.6m convertible note in 2023, which was never converted and was not a priced round; a €2.4m seed in 2024; and €15m led by Kestrel Partners last month, the next priced round after that seed.',
      'People: 54 in total — Lisbon 31, Porto (engineering) 9, Porto (commercial) 5, fully remote 9.',
      'Balance sheet: €18.0m of cash at close. Net burn ran at €1.2m per month through last quarter; the hiring plan the board signed takes it to €1.5m per month from this month onward.',
    ].join('\n'),
  },
  Pipthorn: {
    text: [
      'Pipthorn — diligence dossier',
      'Funding history: €600k friends-and-family in 2023, a €4m seed in 2025, and a €12m round in early 2026 that the company calls its Series A. The €26m that closed in March is the priced round immediately after that one.',
      'People: 88 in total — Warsaw 61, Lisbon 15, Madrid (commercial) 7, Madrid (finance) 5.',
      'Balance sheet: €30.0m of cash on hand. Net burn was €2.5m per month before the March restructuring and is €2.0m per month now.',
    ].join('\n'),
  },
  'Larkmoor Bio': {
    text: [
      'Larkmoor Bio — diligence dossier',
      'Funding history: the company has raised once, a €3.5m round in 2025 that its investors booked as a seed. Nothing has closed since.',
      'People: 40 in total — Ghent 15, Barcelona (lab) 18, Barcelona (everything else) 7.',
      'Balance sheet: €2.8m of cash on hand. Net burn is €0.35m per month and the board has approved no change to it.',
    ].join('\n'),
  },
};

/** Per-person reference notes. Keyed by the person's name — the nested node's
 *  identity field — so the stub invoker reaches them the same way the company
 *  dossiers are reached. */
const SYNTHESIS_PEOPLE: Record<string, TransformInvocationResult> = {
  'Nuno Cardoso': {
    text: 'Nuno Cardoso — reference note\nNuno co-founded the company in 2021, after six years at Siemens Energy. He reports to the board.',
  },
  'Elif Yildiz': {
    text: 'Elif Yildiz — reference note\nElif joined from Adyen, where she ran the payments platform team for four years; before Adyen she was at Klarna. In her current role she reports to whoever runs the company.',
  },
  'Aitana Ruiz': {
    text: 'Aitana Ruiz — reference note\nAitana started the company straight out of a two-year stint at Santander. She reports to the board.',
  },
  'Kwame Boateng': {
    text: 'Kwame Boateng — reference note\nKwame spent eleven years in credit risk at Barclays, having joined them from Lloyds, and then did a six-month advisory stint at Ridgeback Capital between leaving Barclays and joining us. He reports to the person who started this company.',
  },
  'Sigrid Halvorsen': {
    text: 'Sigrid Halvorsen — reference note\nSigrid has been here since the company was founded; this is her first role outside academia. She reports to whoever runs operations here.',
  },
  'Tomas Neves': {
    text: 'Tomas Neves — reference note\nTomas was previously at Novo Nordisk. He reports to the board.',
  },
};

const H2: Fixture = {
  id: 'nested_synthesis',
  title: 'Nested synthesis — two-stage companies with two-stage people',
  asks: 'do the second-stage answers survive when none of them is stated: HQ headcount needs the first-stage city, the round needs an ordering, runway needs arithmetic, and a reporting line needs the sibling who holds the named role',
  source: SYNTHESIS_SOURCE,
  extract: extract([
    stage(
      [],
      [
        node('company', 'each company introduced on the trip', [
          stage([
            field('name', "the company's name, exactly as written"),
            field('website', "the company's website URL, exactly as it appears"),
            field('hq_city', 'the city this company is headquartered in'),
            field('sector', "which of the fund's thesis areas this company falls under", 'Thesis'),
          ]),
          stage(
            [
              field(
                'stage',
                "the funding stage of this company's most recent PRICED round",
                'FundingStage',
              ),
              field(
                'headcount_at_hq',
                "the total number of people based in this company's HEADQUARTERS city, adding together every office or team listed as being there — not the company total, and not the largest location",
                'number',
              ),
              field(
                'runway_months',
                'how many months of runway this company has from now: cash on hand divided by the monthly net burn rate that applies GOING FORWARD, as a whole number of months',
                'number',
              ),
            ],
            [
              node(
                'person',
                'each person who WORKS AT THIS COMPANY. Someone who attended a meeting on behalf of an investor does not work there',
                [
                  stage([
                    field('name', "the person's full name, with no title or honorific"),
                    field('role', 'their role at this company, lowercased, as written'),
                  ]),
                  stage(
                    [
                      field(
                        'prior_employer',
                        'the company this person worked at IMMEDIATELY BEFORE this one — the most recent of them, where the note lists several; null if the note does not say',
                      ),
                      field(
                        'reports_to',
                        'the full name of the person this person reports to. The note describes them by what they DO rather than by name; the answer is whoever at this company does it. Null where they report to the board or to nobody',
                      ),
                    ],
                    [],
                    ['bakeoff_person'],
                  ),
                ],
              ),
            ],
            ['bakeoff_profile'],
          ),
        ]),
      ],
    ),
  ]),
  enrichment: { bakeoff_profile: SYNTHESIS_PROFILES, bakeoff_person: SYNTHESIS_PEOPLE },
  expected: {
    company: {
      identity: 'name',
      closed: { sector: THESES, stage: STAGES },
      entities: [
        {
          key: 'Sablewind',
          fields: {
            name: 'Sablewind',
            website: 'https://sablewind.energy',
            hq_city: 'Porto',
            sector: 'climate',
            // "the next priced round after the seed" — never called a Series A
            // anywhere, and the convertible note before it is not a round.
            stage: 'series-a',
            // Porto is the HQ, listed as two separate teams (9 + 5); Lisbon is
            // the bigger single number and the wrong answer.
            headcount_at_hq: 14,
            // 18.0 over the FORWARD burn of 1.5, not the 1.2 quoted first.
            runway_months: 12,
          },
          children: {
            person: {
              identity: 'name',
              entities: [
                {
                  key: 'Nuno Cardoso',
                  fields: {
                    name: 'Nuno Cardoso',
                    role: 'ceo',
                    prior_employer: 'Siemens Energy',
                    reports_to: null,
                  },
                },
                {
                  // Two prior employers in one sentence; only the nearer one is
                  // the answer. Reports to "the chief executive" — a role, whose
                  // holder is the sibling entity.
                  key: 'Elif Yildiz',
                  fields: {
                    name: 'Elif Yildiz',
                    role: 'vp engineering',
                    prior_employer: 'Adyen',
                    reports_to: 'Nuno Cardoso',
                  },
                },
              ],
            },
          },
        },
        {
          key: 'Pipthorn',
          fields: {
            name: 'Pipthorn',
            website: 'https://pipthorn.io',
            hq_city: 'Madrid',
            sector: 'fintech',
            // Series A is named explicitly; the answer is the round AFTER it.
            stage: 'series-b',
            // Madrid twice (7 + 5); Warsaw is five times bigger and is not the
            // headquarters, which the source states obliquely.
            headcount_at_hq: 12,
            // 30.0 over the CURRENT 2.0, not the pre-restructuring 2.5.
            runway_months: 15,
          },
          children: {
            person: {
              identity: 'name',
              entities: [
                {
                  key: 'Aitana Ruiz',
                  fields: {
                    name: 'Aitana Ruiz',
                    role: 'founder',
                    prior_employer: 'Santander',
                    reports_to: null,
                  },
                },
                {
                  // Three employers in one sentence; the answer is the short
                  // advisory stint mentioned LAST, at a firm the source names
                  // as an investor rather than as one of the companies.
                  key: 'Kwame Boateng',
                  fields: {
                    name: 'Kwame Boateng',
                    role: 'head of credit',
                    prior_employer: 'Ridgeback Capital',
                    reports_to: 'Aitana Ruiz',
                  },
                },
              ],
            },
          },
        },
        {
          key: 'Larkmoor Bio',
          fields: {
            name: 'Larkmoor Bio',
            website: 'https://larkmoorbio.com',
            hq_city: 'Barcelona',
            sector: 'healthcare',
            stage: 'seed',
            // Barcelona twice (18 + 7).
            headcount_at_hq: 25,
            runway_months: 8,
          },
          children: {
            person: {
              identity: 'name',
              entities: [
                {
                  // "Whoever runs operations here" — the OTHER person at this
                  // company, not the most senior-sounding one, and named by the
                  // job rather than the title.
                  key: 'Sigrid Halvorsen',
                  fields: {
                    name: 'Sigrid Halvorsen',
                    role: 'chief scientific officer',
                    // The null. Her note names no employer at all, and the
                    // pressure on every other person's note is to produce one.
                    prior_employer: null,
                    reports_to: 'Tomas Neves',
                  },
                },
                {
                  key: 'Tomas Neves',
                  fields: {
                    name: 'Tomas Neves',
                    role: 'chief operating officer',
                    prior_employer: 'Novo Nordisk',
                    reports_to: null,
                  },
                },
              ],
            },
          },
        },
      ],
    },
  },
};

export const FIXTURES: Fixture[] = [F1, F2, F3, F4, F5, F6, F7, H1, H2];
