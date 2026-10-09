import type { OntologyTemplate } from './types';

import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import PropertyCardinality from '../../../generated/kysely/knowledge/PropertyCardinality';
import { prop, edge, fuzzy, exact } from './types';

const vcDealflow: OntologyTemplate = {
  key: 'vc-dealflow',
  name: 'VC Dealflow',
  description:
    'Track organisations, people, and deals from dealflow communications and investor updates',
  preview: ['Organisation', 'Person', 'Deal'],

  nodeTypes: [
    // ── Message types ──

    {
      key: 'investor_update_message',
      name: 'Investor Update',
      description:
        'A periodic update from a portfolio company to its investors — contains metrics, highlights, challenges, and asks',
      category: 'message',
      displayNameTemplate: "{From Company}'s {Date} Update",
      properties: [
        {
          key: 'update_date',
          name: 'Date',
          description: 'When this update was sent or published (ISO date)',
          valueType: PropertyValueType.date,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'update_summary',
          name: 'Summary',
          description:
            'A concise summary of the investor update — key metrics, notable changes, and overall sentiment',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'update_revenue',
          name: 'Revenue',
          description: 'Reported revenue or ARR as a full integer in stated currency (e.g. $1.2M ARR = 1200000)',
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'update_burn',
          name: 'Monthly Burn',
          description: 'Reported monthly burn rate as a full integer in stated currency',
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'update_runway',
          name: 'Runway',
          description: 'Reported runway in months (e.g. "18 months" = 18)',
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'update_headcount',
          name: 'Headcount',
          description: 'Current team size if mentioned',
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'update_highlights',
          name: 'Highlights',
          description: 'Key wins, milestones, or positive developments reported in this update',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'update_challenges',
          name: 'Challenges',
          description: 'Key challenges, risks, or problems the company is facing',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'update_asks',
          name: 'Asks',
          description: 'What the company is asking of investors — intros, hiring help, follow-on interest, advice, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'update_fundraising',
          name: 'Fundraising Signal',
          description: 'Any indication the company is fundraising or planning to — e.g. "opening Series B", "extending runway", "exploring strategic options"',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
      ],
    },
    {
      key: 'dealflow_message',
      name: 'Dealflow Message',
      description:
        'An inbound dealflow communication — email forward, Slack message, or direct submission containing information about one or more companies seeking funding',
      category: 'message',
      displayNameTemplate: 'Dealflow: {Mentions Org}',
      properties: [
        {
          key: 'dealflow_date',
          name: 'Date',
          description: 'When this message was sent or received (ISO date)',
          valueType: PropertyValueType.date,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'dealflow_summary',
          name: 'Summary',
          description:
            'A concise summary of the dealflow message — who sent it, what companies are being pitched, and the key ask',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
      ],
    },

    // ── Core object types ──

    {
      key: 'organisation',
      name: 'Organisation',
      description: 'A company, investment firm, or other organization encountered in dealflow',
      category: 'object',
      unique: [[exact(prop('org_website'))], [fuzzy(prop('org_name'))]],
      properties: [
        {
          key: 'org_name',
          name: 'Name',
          description: "The organisation's name",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'org_website',
          name: 'Website',
          description:
            "The organisation's website domain(s). Multi-valued — a single org may have several domains (e.g. molten.vc and moltenventures.com); any matches against this set count as the same org.",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
          cardinality: PropertyCardinality.multi,
        },
        {
          key: 'org_description',
          name: 'Description',
          description: 'What the organisation does — product, market, and value proposition',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
        {
          key: 'org_headquarters',
          name: 'Headquarters',
          description: 'Where the organisation is headquartered (city, country)',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'org_sector',
          name: 'Sector',
          description:
            'Primary sector or vertical — fintech, healthcare, SaaS, developer tools, climate, etc.',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
    {
      key: 'person',
      name: 'Person',
      description:
        'An individual — founder, team member, investor, or contact encountered in dealflow',
      category: 'object',
      unique: [[exact(prop('person_email'))], [exact(prop('person_linkedin'))], [fuzzy(prop('person_name'))]],
      properties: [
        {
          key: 'person_name',
          name: 'Name',
          description: "The person's full name",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'person_email',
          name: 'Email',
          description: "The person's email address",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'person_linkedin',
          name: 'LinkedIn URL',
          description: "The person's LinkedIn profile URL",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'person_description',
          name: 'Description',
          description: 'Background — prior companies, expertise, notable achievements',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
      ],
    },

    // ── Deal ──

    {
      key: 'deal',
      name: 'Deal',
      description:
        'A potential investment being evaluated — scoped to its parent organisation. Tracks pipeline status, round details, and sourcing',
      category: 'object',
      displayNameTemplate: '{Deal For} — {Round Type}',
      unique: [[fuzzy(prop('deal_round_type')), exact(edge('deal_for', 'outgoing'))]],
      properties: [
        {
          key: 'deal_status',
          name: 'Status',
          description: 'Current pipeline status',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
          enumValues: ['Sourced', 'Considering', 'Committed', 'Invested', 'Passed', 'Lost'],
        },
        {
          key: 'deal_round_type',
          name: 'Round Type',
          description: 'The funding round stage',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
          enumValues: [
            'Pre-Seed',
            'Seed',
            'Series A',
            'Series B',
            'Series C',
            'Series D+',
            'Bridge',
            'Growth',
          ],
        },
        {
          key: 'deal_amount',
          name: 'Raise Amount',
          description:
            'The total amount being raised, as a full integer in stated currency (e.g. $1.5M = 1500000)',
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'deal_currency',
          name: 'Currency',
          description: 'Currency of the raise amount (e.g. USD, EUR, GBP)',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'deal_lead',
          name: 'Lead By',
          description: 'Who is leading the round, if mentioned',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'deal_source_type',
          name: 'Source Type',
          description: 'How the deal was sourced',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
          enumValues: ['inbound', 'referral', 'cold_outreach', 'event', 'portfolio_intro'],
        },
        {
          key: 'deal_summary',
          name: 'Summary',
          description:
            'A concise summary of the deal — what the company does, the round, and the investment thesis',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
      ],
    },

    // ── TG-parity object types (wave-1 golden path) ──
    // Added by R14 (plans/2026-05-19-tg-extraction-parity/_execution/wave-1/R14-ontology-substitution.md)
    // to support the wave-1 fixture's `targetTypeRef` references. These are
    // additive — the existing `deal` / `organisation` / `person` triad is the
    // canonical dealflow shape; `opportunity` / `funding_round` /
    // `round_participation` form a lighter-weight projection the TG fixture
    // populates from a single inbound dealflow message.

    {
      key: 'opportunity',
      name: 'Opportunity',
      description:
        'A lightweight investment opportunity surfaced from a dealflow message — paired with funding_round / round_participation to capture the round-level detail',
      category: 'object',
      unique: [[fuzzy(prop('company'))]],
      properties: [
        {
          key: 'company',
          name: 'Company',
          description: 'Company name as stated in the dealflow message',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'summary',
          name: 'Summary',
          description: 'One-line summary of the opportunity — what the company does and the ask',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.llm,
        },
      ],
    },
    {
      key: 'funding_round',
      name: 'Funding Round',
      description:
        'A funding round mentioned in a dealflow message — captures the round name, stage, and amount. Participants are tracked as scoped round_participation entries',
      category: 'object',
      unique: [[fuzzy(prop('name'))]],
      properties: [
        {
          key: 'name',
          name: 'Name',
          description: 'Human-readable round name (e.g. "Acme Seed Round")',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'stage',
          name: 'Stage',
          description: 'Round stage',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
          enumValues: ['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series C+'],
        },
        {
          key: 'amount',
          name: 'Amount',
          description: 'Total amount raised, as a full integer in stated currency (e.g. $1.5M = 1500000)',
          valueType: PropertyValueType.number,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
    {
      key: 'round_participation',
      name: 'Round Participation',
      description:
        'One investor\'s participation in a funding round — compound-scoped to (funding_round via `participants`) + investor_name. Same investor name under the same round resolves to the same node',
      category: 'object',
      displayNameTemplate: '{Investor Name} in {Participants}',
      unique: [[fuzzy(prop('investor_name')), exact(edge('participants', 'incoming'))]],
      properties: [
        {
          key: 'investor_name',
          name: 'Investor Name',
          description: 'Name of the investor participating in this round',
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
        {
          key: 'lead',
          name: 'Lead',
          description: 'Whether this investor is the lead of the round',
          valueType: PropertyValueType.boolean,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },
  ],

  edgeTypes: [
    // ── Message → Organisation / Person ──

    {
      key: 'dealflow_mentions_org',
      outboundName: 'Mentions Org',
      inboundName: 'Mentioned In Dealflow',
      description: 'A company mentioned or pitched in this dealflow message',
      source: 'dealflow_message',
      target: 'organisation',
      required: false,
    },
    {
      key: 'update_from_company',
      outboundName: 'From Company',
      inboundName: 'Investor Updates',
      description: 'The portfolio company sending this investor update',
      source: 'investor_update_message',
      target: 'organisation',
      required: true,
    },

    // ── Person → Organisation ──

    {
      key: 'member_of',
      outboundName: 'Member Of',
      inboundName: 'Members',
      description: 'This person is a member, employee, or founder at the organisation',
      source: 'person',
      target: 'organisation',
      required: false,
      properties: [
        {
          key: 'member_role',
          name: 'Role',
          description: "The person's role or title — CEO, CTO, Partner, Co-founder, etc.",
          valueType: PropertyValueType.text,
          evaluationStrategy: EvaluationStrategy.latest,
        },
      ],
    },

    // ── Deal links ──

    {
      key: 'deal_for',
      outboundName: 'Deal For',
      inboundName: 'Deals',
      description: 'The organisation this deal is evaluating',
      source: 'deal',
      target: 'organisation',
      required: true,
    },
    {
      key: 'dealflow_sent_by',
      outboundName: 'Sent By',
      inboundName: 'Sent Dealflow',
      description:
        'The person who sent or forwarded this dealflow message (the introducer or source)',
      source: 'dealflow_message',
      target: 'person',
      required: false,
    },

    // ── TG-parity edges (wave-1 golden path) ──
    // Added by R14. Scoping edge between funding_round and round_participation —
    // round_participation's uniqueness combines (incoming `participants` edge +
    // investor_name property), so a round can have multiple participants and
    // re-asserting the same investor against the same round upserts.

    {
      key: 'participants',
      outboundName: 'Participants',
      inboundName: 'Participates In',
      description: 'An investor participating in this funding round',
      source: 'funding_round',
      target: 'round_participation',
      required: false,
    },
  ],

  extractionGraphs: [
    {
      key: 'dealflow',
      name: 'Dealflow',
      description: 'Extract companies, people, team, and deal information from inbound dealflow',
      messageNodeType: 'dealflow_message',
      children: [
        {
          edge: 'dealflow_sent_by',
          nodeType: 'person',
          instructions: [
            'Identify the person who sent or forwarded this dealflow message.',
            'This is typically the introducer, referrer, or the person who originated the email.',
            'Look for the sender name/email in the message header, signature, or "From" field.',
            'If the message is a forward, the sender is the person who forwarded it, not the original author.',
          ].join('\n'),
        },
        {
          edge: 'dealflow_mentions_org',
          nodeType: 'organisation',
          instructions: [
            'Identify each company that is the primary subject of this message.',
            'Only extract organisations that the message is ABOUT — not ones mentioned in passing as context, comparisons, or background.',
            'If multiple companies are being pitched, extract each one separately.',
            'Infer the company name from website domains or email addresses if not stated explicitly (e.g., joe@acme.com → "Acme" with website acme.com).',
            'Well-known file hosting domains (docs.google.com, docsend.com, drive.google.com, pitch.com) are NOT company websites.',
            "If the company name cannot be determined from any source, use a descriptive placeholder based on context (e.g., the founder's name or the product area).",
          ].join('\n'),
          children: [
            {
              edge: 'member_of',
              nodeType: 'person',
              instructions: [
                'Extract senior team members: founders, co-founders, and C-suite (CEO, CTO, COO, CFO).',
                'Do NOT extract "X Lead", "Senior X", "VP of X", or similar non-C-suite roles unless they are also a founder.',
                'If more than 4 people appear, keep only C-suite and founders.',
                "People with an email on the company's domain are likely team members, not external contacts.",
                'Do NOT extract advisors, consultants, or investors as team members.',
                "Set the Role edge property to the person's title (CEO, CTO, Co-founder, etc.).",
              ].join('\n'),
            },
            {
              edge: 'deal_for',
              nodeType: 'deal',
              instructions: [
                'Create a deal entry for each investment opportunity being evaluated.',
                'Infer source type from context: forwarded email or "intro from X" → referral, direct submission from founder → inbound, mentioned by portfolio company → portfolio_intro.',
                'Default status to "Sourced" for new inbound deals.',
                'Extract the funding round details (round type, amount, currency, lead) as deal properties.',
              ].join('\n'),
            },
          ],
        },
      ],
    },
    {
      key: 'investor_updates',
      name: 'Investor Updates',
      description: 'Extract the reporting company from portfolio investor updates',
      messageNodeType: 'investor_update_message',
      children: [
        {
          edge: 'update_from_company',
          nodeType: 'organisation',
          instructions: [
            'Identify the single company sending this investor update.',
            'This is the startup reporting progress to its investors, NOT the recipient fund.',
            'Look for the company name in the email subject, header, or opening line.',
          ].join('\n'),
        },
      ],
    },
  ],
};

export { vcDealflow };
