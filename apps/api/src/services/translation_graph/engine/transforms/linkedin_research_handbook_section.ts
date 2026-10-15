// The handbook chapter `linkedin_research` declares on its manifest —
// assembled into the automation book as `plugin:linkedin_research`.
//
// Kept in its own module so the prose imports nothing: the plugin's own
// module pulls in the search, fetch and model chain, and the handbook must not.

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const LINKEDIN_RESEARCH_HANDBOOK_SECTION: HandbookSection = {
  title: 'LinkedIn activity — what a person is up to',
  content: `## LinkedIn activity — what a person is up to

\`linkedin_research\` takes a person's LinkedIn address and works out what they are currently doing — the role and organisation their profile shows, plus recent public activity found on the web — then writes it up in a paragraph you can read.

### the-shape

\`\`\`
import { linkedin_research } from plugins

node Person: "each person named in this message" {
  name:     <text> "the person's name"
  linkedin: <text> "their LinkedIn address, if the message has one"
}

MAP(extract(content, Person), (p) => {
  activity = linkedin_research(url: p.linkedin)
  write crm-[:People]-> {
    unique by (FUZZY \`Name\`)
    Name:          p.name
    Description ?: activity.activity_summary
  }
})
\`\`\`

It runs once per person, inside the \`MAP\`, researching that person's own address. A person whose \`linkedin\` came back empty is skipped — no research, no error.

### what-comes-back

A record, every field of which may be absent:

- \`activity_summary\` — the write-up: current role and organisation, what they appear to be doing now, recent activity with dates where known, and a plain hedge where the public record ends. Each claim carries a bracketed number pointing at the address it rests on.
- \`activity_confidence\` — \`high\`, \`medium\` or \`low\`. Read it before trusting the summary. \`high\` means the profile and two independent recent sources agree; \`medium\`, the profile plus one recent source, or several with nothing dated inside about a year; \`low\`, the profile alone, or sources that fit but say little.
- \`current_role\` and \`current_organisation\` — as the research read them.
- \`activity_sources\` — one address per line, numbered to match the summary's citations.

### when-there-is-nothing-to-find

A result counts as this person's only when it is consistent with their own profile — the organisation, the field, or the location. A namesake's news is left out rather than folded in, so a common name with a sparse profile produces a low-confidence answer instead of somebody else's story. When nothing survives that test, every field is absent: no public signal.

### Common mistakes

- **Expecting it to find a person from a name.** It starts from an address and never searches for one. To turn a name into a profile address, call \`research\` and read its \`linkedin\`, then pass that here.
`,
  engineClaims: [
    {
      construct: 'linkedin_research called per person inside MAP, its write-up filled into a record',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { linkedin_research } from plugins

inbox = email()
crm   = attio(credentials: acme)

node Person: "each person named in this message" {
  name:     <text> "the person's name"
  linkedin: <text> "their LinkedIn address, if the message has one"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  MAP(extract([m.\`Body\`], Person), (p) => {
    activity = linkedin_research(url: p.linkedin)
    write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name:          p.name
      Description ?: activity.activity_summary
    }
  })
}
`,
    },
  ],
};
