import type { Chapter } from '../types';

export const extraction: Chapter = {
  id: 'extraction',
  title: 'Extraction — structured records from unstructured data',
  content: `## Extraction — structured records from unstructured data

\`extract(content, Shape, settings)\` turns text and documents into records you can walk and write from: one declared tree, one model call. For a single value — a summary, a category — use \`ai()\` instead.

### basics

\`\`\`
type Thesis = <"Consumer" | "Infra" | "Health">

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  website: <text | null> "its website, if given"
  stage:   <crm-[:Onboarding]->.Stage> "how far along this company is"
  thesis:  <Thesis> "which of our theses it fits"
  node person: "each person at the company named in the message" {
    name:  <text> "the person's full name"
    email: <text | null> "their email address, if given"
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  content   = [m.Body, ...m-[a:Attachments]->.File]
  companies = extract(content, Company, { tier: "careful" })

  map(companies, (c) => {
    record = write crm-[:Companies]-> { unique by (FUZZY Name), Name: c.name }
    write record-[:Lists]-> { listName: "Onboarding", Stage ?: c.stage }
    c-[p:person]-> {
      write record-[:Team]-> { unique by (FUZZY Name), Name: p.name, Email ?: p.email }
    }
  })
}
\`\`\`

- **Content** is a list, read in the order written: text, files (documents read as text, audio transcribed), and records rendered as text with \`Json.stringify(record)\`. A record put in raw is refused when you save. Spread a list of files in with \`...\`.
- **The shape** is a node declaration: at the top of the file, inside the function or lambda that uses it, or written in place with its header — \`extract(content, node Person: "each person named" { name: <text> "their name" })\`. A shape worked out at run time is refused. Declare a record once and extract it anywhere; \`node X extends Company { … }\` adds fields for a later step (anatomy, *declared-structures*).
- **The description carries the cardinality**: "each company" yields every one, "the company" one. A record with nothing in any field is dropped. Where a record may genuinely not be there, say so — "the company, if mentioned" — or one gets invented to fill the slot.
- **Every field is something the model was asked for and may not have found.** A \`<text>\` field it did not find is \`""\`: test \`!= ""\` (a null test on it is refused). A \`<text | null>\` field arrives absent instead. A typed field (\`<number>\`, \`<date>\`, \`<boolean>\`, a set of values) is \`T | absent\`: write it with \`?:\`, fall back with \`coalesce\`, or guard it (expressions, *values-that-may-not-be-there*).
- **A field's type is its annotation**: a primitive, a set of values you write (\`type Thesis = …\`), or a system field's type borrowed by path (\`<crm-[:Onboarding]->.Stage>\`). A set tells the model which values to pick from, and a value outside it is flagged when you save. A borrowed option field binds that field's live options, re-read every run. An annotation that disagrees with the field you write it into is flagged.
- **Nest a \`node\`** when a child only makes sense inside its parent. It arrives attached: walk it with \`c-[p:person]->\`.
- **The result** is a list of records. Read it with \`map\`, walk nested nodes, and write and link into it as into any record the run built. Each field's evidence names the content item it came from.
- **It is a value like any other**: \`map(extract(…), f)\`, \`return extract(…)\`, or bound when read more than once. It is refused inside a walk's \`WHERE\` and as a statement on its own line.
- Declare the records and fields you will use, not every one you could: a larger tree costs more.

\`extractOne(content, Shape, settings)\` gives the single record the content describes, as TypeScript's \`find\` sits beside \`filter\`:

\`\`\`
sender = extractOne(content, node Sender: "the company that sent this message" { name: <text> "its name" })
\`\`\`

- Describe the one thing (\`"the company"\`, not \`"each company…"\`). The result is \`Shape | absent\`; handle it like any maybe-absent value (\`coalesce(sender.name, "unknown")\`, a guard).
- A reply naming several is tried once more, then the call fails.

A reply that does not fit the shape is tried once more, then the call fails. Inside \`map\`, \`onError: "warn"\` leaves that record out and carries on.

### a-yes-or-no-field

\`\`\`
node Lead: "the company this email is about" {
  name:      <text> "the company's name"
  \`Is Warm\`: <boolean> "true when the sender already knows us — a referral, a reply to outreach, or a repeat contact; false otherwise"
}

lead = extractOne([m.Body], Lead)
if (lead == null) { fail("no company in this email") }
if (lead.\`Is Warm\`) {
  write crm-[:Companies]-> { unique by (FUZZY Name), Name: lead.name, Description: "Warm Lead" }
}
\`\`\`

A \`<boolean>\` field is the condition itself. A missing one reads as false; guard it with \`== null\` when "couldn't tell" should stop the run. A description that argues both ways gives the model a real decision rather than a value to lean toward.

### how-hard-it-works

\`tier\` says how much thinking the extraction is worth — the same three words \`ai()\` takes:

- \`"quick"\` — fast and cheap. Right when the values sit in the text and only have to be lifted out: names, dates, amounts.
- \`"careful"\` — a solid general answer. Right when a field calls for a small judgement, or the source is messy.
- \`"thorough"\` — slow and expensive, and it genuinely reasons. Worth it when a field must be worked out rather than found.

Leave it off and the extraction sizes itself from the tree you declared. \`model\` (a model this installation can reach, by name) and \`effort\` (\`"low"\`, \`"medium"\`, \`"high"\`, \`"xhigh"\`) override the tier's. An unknown setting, or an unreachable model, is refused when you save.

### repeated-calls

The model reads content it has already seen in this run for a fraction of the price, but only the part that comes first and is identical:

- Put what every call shares first and what belongs to one record last — \`[...content, Json.stringify(c)]\`.
- Keep the tier (or the model and effort) the same across calls that read the same content.
- Give the \`map\` \`initialConcurrency: 1\`, so the first call has read the shared content before the rest start.

The shape always goes after the content, so a second extraction with a different shape over the same content is cheap too. The engine marks the cache itself; the order you write is the only thing to get right.

### enrichment

Enrich by composition: extract, map over the results, call plugins, extract again over what they returned, then merge.

\`\`\`
import { fetch_url, research } from plugins

node CompanyDetail: "the company" {
  summary: <text> "one line on what the company does"
}

node Detailed {
  name:    <text>
  website: <text | null>
  summary: <text | null>
  node person { name: <text> }
}

content   = [m.Body]
companies = extract(content, Company, { tier: "careful" })

detailed = map(companies, (c) => {
  page    = fetch_url(url: c.website)
  more    = research(name: c.name, context: m.Subject, questions: "what the company does")
  details = extractOne([...content, Json.stringify(c), coalesce(page, ""), coalesce(more.dossier, "")], CompanyDetail, { tier: "careful" })
  return graph<Detailed> { ...c, ...details }
}, { initialConcurrency: 1, concurrency: 4, onError: "warn" })

map(detailed, (d) => {
  record = write crm-[:Companies]-> { unique by (FUZZY Name), Name: d.name, Description ?: d.summary }
  d-[p:person]-> { write record-[:Team]-> { unique by (FUZZY Name), Name: p.name } }
})
\`\`\`

- A plugin is imported (\`import { fetch_url } from plugins\`) and called with named arguments. It returns a value: \`fetch_url\` the page's text, \`research\` a record read by name (\`more.summary\`, \`more.dossier\`). Anything it found nothing for is absent, so \`coalesce\` it before it goes into content. Each plugin's own chapter (\`plugin:…\`) says what it takes and returns.
- \`graph<Detailed> { ...c, ...details }\` copies the record and then its detail as a snapshot you can walk and write from; the declaration decides which fields, and a nested node is followed through the record's edge of the same name. A later field wins.
- \`details\` may be absent, so a field only it supplies may be too. A required field fed from it is refused when you save: declare it \`<text | null>\`, or write it after the spread with a fallback (\`summary: coalesce(details.summary, "")\`).
- \`{ ...c, ...details }\` builds a dict instead, read with a dot. Use it when nothing needs to walk the result.

### long-documents

Cut a long document into pieces, read each on its own, and gather what they found before any of it reaches a system:

\`\`\`
node Found {
  node companies {
    name:    <text>
    website: <text | null>
  }
}

pieces  = Text.chunks(coalesce(File.read(first(docs)), ""), { size: 40000, overlap: 2000 })
deduped = graph<Found> {}

map(pieces, (p) => {
  map(extract([p], Company, { tier: "quick" }), (c) => {
    write deduped-[:companies]-> { unique by (FUZZY name), name: c.name, website ?: c.website }
  })
})

deduped-[c:companies ORDER BY c.name]-> {
  write crm-[:Companies]-> { unique by (FUZZY Name), Name: c.name }
}
\`\`\`

- \`extract(pieces, …)\` is ONE extraction reading every piece; the \`map\` makes one per piece.
- A write into the local graph merges by \`unique by\`, so a company found in two pieces lands once.
- When a run says a reading was *continued*, the answer ran past its output ceiling: cut smaller. \`Text.chunks(text, { entities: 20 })\` sizes each piece by the records it is expected to hold.

### attaching-the-source-files

The files an extraction read are the ones you put in its content, so attach them from where they came:

\`\`\`
record = write crm-[:Companies]-> { unique by (FUZZY Name), Name: c.name }
m-[a:Attachments]-> {
  write record-[:Files]-> { File: a.File }
}
\`\`\`

A document a plugin downloaded comes back on its result (\`vc_url_retrieval\`'s \`file\`), and is written the same way.
`,
  engineClaims: [
    {
      construct: 'the extraction call — extract(content, Shape, settings), then a per-record extractOne in map',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  website: <text | null> "its website, if given"
  node person: "each person at the company named in the message" {
    name: <text> "the person's full name"
  }
}

node CompanyDetail: "the company" {
  summary: <text> "one line on what the company does"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  files     = m-[a:Attachments]->.File
  content   = [m.Body, ...files]
  companies = extract(content, Company, { tier: "careful" })

  detailed = map(companies, (c) => {
    details = extractOne([...content, Json.stringify(c)], CompanyDetail, { tier: "careful" })
    return { ...c, ...details }
  }, { initialConcurrency: 1, concurrency: 4, onError: "warn" })

  map(companies, (c) => {
    record = write crm-[:Companies]-> { unique by (FUZZY Name) Name: c.name }
    c-[p:person]-> {
      write record-[:Team]-> { unique by (FUZZY Name) Name: p.name }
    }
  })
}
`,
    },
    {
      construct: 'merging an extracted record with its detail — { ...c, ...details } and graph<Shape> { ...c, ...details }',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  website: <text | null> "its website, if given"
  node person: "each person at the company named in the message" {
    name: <text> "the person's full name"
  }
}

node CompanyDetail: "the company" {
  summary: <text> "one line on what the company does"
}

node Detailed {
  name:    <text>
  website: <text | null>
  summary: <text | null>
  node person {
    name: <text>
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  content   = [m.Body]
  companies = extract(content, Company, { tier: "careful" })

  merged = map(companies, (c) => {
    details = extractOne([...content, Json.stringify(c)], CompanyDetail, { tier: "careful" })
    return { ...c, ...details }
  }, { initialConcurrency: 1, concurrency: 4, onError: "warn" })
  map(merged, (d) => {
    write crm-[:Companies]-> { unique by (FUZZY Name) Name: d.name, Description: coalesce(d.summary, "") }
  })

  detailed = map(companies, (c) => {
    details = extractOne([...content, Json.stringify(c)], CompanyDetail, { tier: "careful" })
    return graph<Detailed> { ...c, ...details }
  })
  map(detailed, (d) => {
    record = write crm-[:Companies]-> { unique by (FUZZY Name) Name: d.name, Description: coalesce(d.summary, "") }
    d-[p:person]-> {
      write record-[:Team]-> { unique by (FUZZY Name) Name: p.name }
    }
  })
}
`,
    },
    {
      construct: 'a <boolean> extraction field on extractOne, guarded then branched on directly with if',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

node Lead: "the company this email is about" {
  name:      <text> "the company's name"
  \`Is Warm\`: <boolean> "true when the sender already knows us — a referral, a reply to outreach, or a repeat contact; false otherwise"
}

function \`Triage\`(m: <inbox-[:Email]->>) {
  lead = extractOne([m.Body], Lead)
  if (lead == null) { fail("no company in this email") }
  if (lead.\`Is Warm\`) {
    write crm-[:Companies]-> { unique by (FUZZY Name), Name: lead.name, Description: "Warm Lead" }
  }
}
`,
    },
    {
      construct: 'the extraction call over a body and its files — a borrowed option type, a written set of values, a nested node written along its parent, and the source files attached',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

type Thesis = <"Consumer" | "Infra" | "Health">

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  website: <text | null> "its website, if given"
  stage:   <crm-[:\`VC Deal Flow\`]->.Stage> "how far along the pipeline this company is"
  thesis:  <Thesis> "which of our theses it fits"
  node person: "each person at the company named in the message" {
    name:  <text> "the person's full name"
    email: <text | null> "their email address, if given"
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  content   = [m.Body, ...m-[a:Attachments]->.File]
  companies = extract(content, Company, { tier: "careful" })

  map(companies, (c) => {
    record = write crm-[:Companies]-> { unique by (FUZZY Name), Name: c.name, Description ?: c.thesis }
    write record-[:Lists]-> { listName: "VC Deal Flow", Stage ?: c.stage }
    c-[p:person]-> {
      write record-[:Team]-> { unique by (FUZZY Name), Name: p.name, Email ?: p.email }
    }
    m-[a:Attachments]-> {
      write record-[:Files]-> { File: a.File }
    }
  })
}
`,
    },
    {
      construct: 'enrichment by composition — plugin calls inside map, extractOne over shared content plus what they returned, merged into graph<Shape> and written along its nested node',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials
import { fetch_url, research } from plugins

inbox = connect email
crm   = connect attio using acme

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  website: <text | null> "its website, if given"
  node person: "each person at the company named in the message" {
    name: <text> "the person's full name"
  }
}

node CompanyDetail: "the company" {
  summary: <text> "one line on what the company does"
}

node Detailed {
  name:    <text>
  website: <text | null>
  summary: <text | null>
  node person { name: <text> }
}

function \`Enrich\`(m: <inbox-[:Email]->>) {
  content   = [m.Body]
  companies = extract(content, Company, { tier: "careful" })

  detailed = map(companies, (c) => {
    page    = fetch_url(url: c.website)
    more    = research(name: c.name, context: m.Subject, questions: "what the company does")
    details = extractOne([...content, Json.stringify(c), coalesce(page, ""), coalesce(more.dossier, "")], CompanyDetail, { tier: "careful" })
    return graph<Detailed> { ...c, ...details }
  }, { initialConcurrency: 1, concurrency: 4, onError: "warn" })

  map(detailed, (d) => {
    record = write crm-[:Companies]-> { unique by (FUZZY Name), Name: d.name, Description ?: d.summary }
    d-[p:person]-> { write record-[:Team]-> { unique by (FUZZY Name), Name: p.name } }
  })
}
`,
    },
    {
      construct: 'a long document read with File.read, cut with Text.chunks, extracted per piece in map, merged into a typed empty graph by unique by, then written',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

node Company: "each company named" {
  name:    <text> "the company's name"
  website: <text | null> "its website, if given"
}

node Found {
  node companies {
    name:    <text>
    website: <text | null>
  }
}

function \`Intake Documents\`(go: <runs-[:Invocation]->>) {
  docs    = go-[:Files]->.File
  pieces  = Text.chunks(coalesce(File.read(first(docs)), ""), { size: 40000, overlap: 2000 })
  deduped = graph<Found> {}

  map(pieces, (p) => {
    map(extract([p], Company, { tier: "quick" }), (c) => {
      write deduped-[:companies]-> { unique by (FUZZY name), name: c.name, website ?: c.website }
    })
  })

  deduped-[c:companies ORDER BY c.name]-> {
    write crm-[:Companies]-> { unique by (FUZZY Name), Name: c.name }
  }
}

listen to runs {} fire \`Intake Documents\`
`,
    },
    {
      construct: 'plugins called plainly, outside any extraction',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials
import { fetch_url, research, vc_url_retrieval } from plugins

inbox = connect email
crm   = connect attio using acme

function \`Enrich\`(m: <inbox-[:Email]->>) {
  linked = vc_url_retrieval(text: m.Body)
  deck   = first(linked)
  page   = fetch_url(url: "https://example.com")
  more   = research(name: m.Subject, questions: "what it does, which sector, where it is based")
  write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name:          m.Subject
    Description ?: coalesce(more.summary, page, deck.text)
    Domains ?:     more.website
  }
}
`,
    },
    {
      construct: 'extraction call — an inline shape, only around a nested call, a walk spread into the content, and enrichment in map with a plugin call',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

import { fetch_url } from plugins

node Profile: "more about the company described last" {
  summary: <text> "one line on what the company does"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  pdfs      = m-[a:Attachments WHERE a.\`Content Type\` == "application/pdf"]->.File
  content   = [m.Body, ...pdfs]
  companies = extract(content, node Company: "each company named in this message" {
    name:    <text> "the company's name"
    website: <text | null> "its website, if given"
  }, { tier: "careful", effort: "medium" })

  map(companies, (c) => {
    page   = fetch_url(url: c.website)
    detail = extractOne([...content, Json.stringify(c), coalesce(page, "")], Profile, { tier: "careful", effort: "medium" })
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:          c.name
      Description ?: detail.summary
    }
  }, { initialConcurrency: 1, concurrency: 4, onError: "warn" })
}

`,
    },
    {
      construct: 'extractOne(content, Shape, settings) — the single record or absent, handled, nested, and enriching each record in map',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

node Company: "each company named in this message" {
  name:      <text> "the company's name"
  employees: <number> "its headcount"
}

node CompanyDetail: "the company" {
  summary:   <text> "one line on what the company does"
  employees: <number> "its headcount"
}

function \`Enrich\`(m: <inbox-[:Email]->>) {
  content   = [m.Body]
  companies = extract(content, Company, { tier: "careful" })

  detailed = map(companies, (c) => {
    details = extractOne([...content, Json.stringify(c)], CompanyDetail, { tier: "careful" })
    return { ...c, ...details }
  }, { initialConcurrency: 1, concurrency: 4, onError: "warn" })
  map(detailed, (d) => {
    write crm-[:Companies]-> { unique by (FUZZY Name) Name: d.name, Description: coalesce(d.summary, "") }
  })

  sender = extractOne(content, node Sender: "the company that sent this message" { name: <text> "its name" })
  big    = coalesce(extractOne(content, CompanyDetail).employees, 0) > 50
  write crm-[:Companies]-> { unique by (FUZZY Name) Name: coalesce(sender.name, "unknown"), Description: big ? "large" : "small" }
}
`,
    },
  ],
};
