// The recorded cases: each bundled plugin over the paths it takes most — a
// page fetched, a document fetched, a gated deck, a profile, a search that
// finds the subject and one that does not. Every answer the plugin's host
// would give is scripted here; nothing reaches a network.

export interface ParityCase {
  name: string;
  plugin: string;
  config: Record<string, unknown>;
  extractedContext: Record<string, unknown>;
  env?: Record<string, string>;
  chat?: Record<string, string>;
  structured?: Record<string, unknown>;
  webChat?: { searches?: string[]; fetches?: string[]; text: string };
  search?: Record<string, Array<{ link: string; title: string; snippet: string }>>;
  linkedinSearch?: Array<{ link: string; title?: string; snippet?: string }>;
  pages?: Record<string, string>;
  documentSources?: string[];
  decks?: Record<string, { kind: 'text'; text: string } | { kind: 'document'; documentId: string }>;
  documentTexts?: Record<string, string>;
  storedDocuments?: Record<string, { objectUri: string; name: string }>;
  profiles?: Record<string, string>;
}

const ACME_PAGE =
  'Acme Rockets builds reusable launch vehicles for small satellites. Founded in Berlin in 2021, ' +
  'Acme has flown four missions and is raising a Series A to scale production.';

const ADA_PROFILE =
  'Ada Lovelace — Founder & CEO at Acme Rockets · Berlin · Previously propulsion lead at Orbital ' +
  'Works. Building reusable launch for small satellites.';

export const PARITY_CASES: ParityCase[] = [
  // ── fetch-url ──
  {
    name: 'fetch-url: a page',
    plugin: 'fetch_url',
    config: { url: 'acme-rockets.example' },
    extractedContext: {},
    pages: { 'https://acme-rockets.example': ACME_PAGE },
  },
  {
    name: 'fetch-url: a page too thin to keep',
    plugin: 'fetch-url',
    config: { url: 'https://thin.example' },
    extractedContext: {},
    pages: { 'https://thin.example': 'Loading…' },
  },
  {
    name: 'fetch-url: a gated deck stored as a document',
    plugin: 'fetch_url',
    config: { url: 'https://docsend.com/view/abc', email: 'ada@vc.example', password: 'pw1' },
    extractedContext: {},
    documentSources: ['https://docsend.com/view/abc'],
    decks: { 'https://docsend.com/view/abc': { kind: 'document', documentId: 'doc-7' } },
    documentTexts: { 'doc-7': 'Acme Rockets — Series A deck. Market, team, traction.' },
    storedDocuments: { 'doc-7': { objectUri: 's3://docs/doc-7.pdf', name: 'Acme deck' } },
  },
  {
    name: 'fetch-url: a profile address',
    plugin: 'fetch_url',
    config: { url: 'https://www.linkedin.com/in/ada-lovelace' },
    extractedContext: {},
    profiles: { 'https://www.linkedin.com/in/ada-lovelace': ADA_PROFILE },
  },
  {
    name: 'fetch-url: no url',
    plugin: 'fetch_url',
    config: { url: '  ' },
    extractedContext: {},
  },
  // ── vc-url-retrieval ──
  {
    name: 'vc-url-retrieval: a deck and a site among a pixel',
    plugin: 'vc_url_retrieval',
    config: {
      text:
        'Hi — our deck is at https://docsend.com/view/abc (passcode: rocket) and the site is ' +
        'https://acme-rockets.example. <img src="https://track.example/p.gif" width=1>',
      email: 'ada@vc.example',
    },
    extractedContext: {},
    chat: {
      knowledge_plugin_url_classify: '{"type":"pitch_deck","password":"rocket"}',
    },
    pages: { 'https://acme-rockets.example': ACME_PAGE, 'https://track.example/p.gif': '' },
    documentSources: ['https://docsend.com/view/abc'],
    decks: { 'https://docsend.com/view/abc': { kind: 'text', text: 'Acme deck as text: team, market, ask.' } },
  },
  {
    name: 'vc-url-retrieval: no links',
    plugin: 'vc_url_retrieval',
    config: { text: 'Lovely to meet you yesterday — let us talk next week.' },
    extractedContext: {},
  },
  // ── linkedin-enrichment ──
  {
    name: 'linkedin-enrichment: found by search',
    plugin: 'linkedin_enrichment',
    config: {},
    extractedContext: { name: { label: 'Name', value: 'Ada Lovelace' }, role: { label: 'Role', value: 'CEO' } },
    chat: { knowledge_plugin_linkedin_identify: '{"name":"Ada Lovelace","company":"Acme Rockets","description":"CEO"}' },
    linkedinSearch: [{ link: 'https://www.linkedin.com/in/ada-lovelace', title: 'Ada Lovelace - Acme' }],
    profiles: { 'https://www.linkedin.com/in/ada-lovelace': ADA_PROFILE },
  },
  {
    name: 'linkedin-enrichment: address already carried',
    plugin: 'linkedin_enrichment',
    config: {},
    extractedContext: { Name: 'Ada Lovelace', LinkedIn: 'https://www.linkedin.com/in/ada-lovelace' },
    profiles: { 'https://www.linkedin.com/in/ada-lovelace': ADA_PROFILE },
  },
  // ── web-research ──
  {
    name: 'web-research: finds and fetches the site',
    plugin: 'web_research',
    config: { name: 'Acme Rockets', context: 'reusable launch vehicles, Berlin' },
    extractedContext: {},
    structured: {
      plan_searches: { queries: ['Acme Rockets reusable launch Berlin'], anchors: ['launch'] },
      confirm_website: { choice: 1, confidence: 'high' },
    },
    search: {
      '*': [
        { link: 'https://acme-rockets.example/', title: 'Acme Rockets — reusable launch', snippet: 'Reusable launch vehicles from Berlin.' },
        { link: 'https://directory.example/acme', title: 'Acme Rockets | Directory', snippet: 'Company profile.' },
      ],
    },
    pages: { 'https://acme-rockets.example': ACME_PAGE },
  },
  {
    name: 'web-research: stands down for a record with a site',
    plugin: 'web_research',
    config: { name: 'Acme Rockets', context: 'launch', website: 'https://acme-rockets.example' },
    extractedContext: {},
  },
  // ── linkedin-research ──
  {
    name: 'linkedin-research: profile, search, synthesis',
    plugin: 'linkedin_research',
    config: { url: 'https://www.linkedin.com/in/ada-lovelace' },
    extractedContext: { name: 'Ada Lovelace' },
    profiles: { 'https://www.linkedin.com/in/ada-lovelace': ADA_PROFILE },
    chat: {
      plugin_linkedin_research_plan:
        '{"organisation":"Acme Rockets","queries":[{"query":"Ada Lovelace Acme Rockets","worth_reading":true}]}',
    },
    search: {
      '*': [{ link: 'https://news.example/acme-series-a', title: 'Acme Rockets raises Series A', snippet: 'Ada Lovelace, CEO of Acme Rockets, said…' }],
    },
    pages: { 'https://news.example/acme-series-a': 'Acme Rockets, led by CEO Ada Lovelace, raised a Series A to scale reusable launch production in Berlin.' },
    structured: {
      report_activity: {
        found: true,
        confidence: 'high',
        current_role: 'Founder & CEO',
        current_organisation: 'Acme Rockets',
        summary: 'Ada Lovelace runs Acme Rockets, which just raised a Series A.',
        sources: ['https://news.example/acme-series-a'],
      },
    },
  },
  // ── research ──
  {
    name: 'research (agentic): a dossier',
    plugin: 'research',
    config: { name: 'Acme Rockets', context: 'reusable launch vehicles, Berlin', questions: 'what it does, where it is based' },
    extractedContext: {},
    env: { RESEARCH_ENGINE: 'agentic' },
    webChat: {
      searches: ['Acme Rockets Berlin launch'],
      fetches: ['https://acme-rockets.example/'],
      text: 'Acme Rockets builds reusable launch vehicles in Berlin [1].',
    },
    search: {
      '*': [{ link: 'https://acme-rockets.example/', title: 'Acme Rockets', snippet: 'Reusable launch.' }],
    },
    pages: { 'https://acme-rockets.example/': ACME_PAGE },
    structured: {
      file_research: {
        found: true,
        answers_everything: true,
        confidence: 'high',
        summary: 'Acme Rockets builds reusable launch vehicles in Berlin.',
        dossier: 'Acme Rockets: reusable launch for small satellites; Berlin; four missions; raising a Series A.',
        sources: ['https://acme-rockets.example/'],
        website: 'https://acme-rockets.example/',
        linkedin: '',
      },
    },
  },
  {
    name: 'research (constrained): a dossier',
    plugin: 'research',
    config: { name: 'Acme Rockets', context: 'reusable launch vehicles, Berlin', questions: 'what it does' },
    extractedContext: {},
    env: { RESEARCH_ENGINE: 'constrained' },
    structured: {
      plan_searches: { queries: ['Acme Rockets reusable launch'], anchors: ['launch'] },
      confirm_website: { choice: 1, confidence: 'high' },
      report_research: {
        found: true,
        answers_everything: true,
        confidence: 'high',
        summary: 'Acme Rockets builds reusable launch vehicles.',
        dossier: 'Reusable launch for small satellites, Berlin.',
        sources: ['https://acme-rockets.example/'],
      },
    },
    search: {
      '*': [{ link: 'https://acme-rockets.example/', title: 'Acme Rockets — reusable launch', snippet: 'Reusable launch vehicles from Berlin.' }],
    },
    pages: { 'https://acme-rockets.example/': ACME_PAGE },
  },
  {
    name: 'research: a bare name is left alone',
    plugin: 'research',
    config: { name: 'Acme' },
    extractedContext: {},
  },
];
