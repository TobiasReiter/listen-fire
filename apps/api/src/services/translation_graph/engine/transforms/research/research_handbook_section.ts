// The handbook chapter `research` declares on its manifest — assembled into
// the automation book as `plugin:research`.
//
// Its own module so the prose imports nothing: the plugin pulls in the search
// index, the scraper chain and the model wrapper, and the handbook must not.

import type { HandbookSection } from 'movement-engine/public/handbook';

export const RESEARCH_HANDBOOK_SECTION: HandbookSection = {
  title: 'Research — what is this person or company, and what do they do?',
  content: `## Research — what is this person or company, and what do they do?

\`research\` takes whatever a record carries — a name, a line of text, a web address, a profile address — looks the subject up on the web, and answers what you want to know about it. Reach for it when a message names people or companies and you want to know more than the message said.

### the-shape

\`\`\`
import { research } from plugins

node Company: "each company named in this message" {
  name:        <text> "the company's name"
  description: <text> "what the message says about it"
  website:     <text> "the company's web address, if the message gives one"
  linkedin:    <text> "the company's LinkedIn address, if the message gives one"
}

node Profile: "the company" {
  summary:  <text> "what the company does, in a sentence"
  sector:   <text> "the sector, in a word or two"
  location: <text> "where the company is based"
}

map(extract(content, Company), (c) => {
  found   = research(c.name, { context: c.description, questions: "what it does, which sector it is in, where it is based", website: c.website, linkedin: c.linkedin })
  profile = extractOne([...content, Json.stringify(c), coalesce(found.dossier, "")], Profile)
  write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name:          c.name
    Domains ?:     found.website
    Description ?: profile.summary
  }
})
\`\`\`

It runs once per company, inside the \`map\`.

### what-you-want-to-know

\`questions\` is what you want to find out, in your own words. The answer is sized to it: say what a company does and which sector it is in, and a few paragraphs come back; say nothing and you get a general account of the subject. Name what the fields you extract next need.

### the-addresses

Pass every address the record carries. Each one is read for what it is: a web address is the subject's own words, a profile address settles who the subject is, and any other link (\`url\`) is evidence alongside them. A record that carries an address is still researched — the address is where the research starts, not a reason to stop.

### what-makes-it-work-without-an-address

\`context\` is the line the message wrote: what the subject does, where it is, who is behind it. That is what tells this subject apart from every other one trading under the same word. A record with no address and nothing beyond a name comes back with nothing, deliberately: a name alone returns the world, and a wrong answer is worse than none — it colours everything extracted after it and lands in whatever the automation writes.

Give it a real sentence and it answers; give it a bare name and it declines. Both are correct, and the run record says which one happened.

### what-comes-back

A record, every field of which may be absent: \`summary\` (the answer to \`questions\`), \`confidence\`, \`sources\` (the addresses it cites), \`website\` and \`linkedin\` (the addresses it resolved or confirmed — a person's or company's profile found from a name), and \`dossier\` (the passages it rests on, under their sources). Read \`summary\` for what \`questions\` covered; put \`dossier\` into a second extraction for anything else. A record it declined comes back empty.

### Common mistakes

- **Leaving \`questions\` out when the next step wants something specific.** The answer is written to the question; with none it is written to the subject in general.
- **Dropping the resolved address.** \`found.website\` is the address the research settled on; write it, or nothing downstream has it.
`,
  engineClaims: [
    {
      construct: 'research called per record inside map, its resolved address written and its dossier read by a second extraction',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials
import { research } from plugins

inbox = connect email
crm   = connect attio using acme

node Company: "each company named in this message" {
  name:        <text> "the company's name"
  description: <text> "what the message says about it"
  website:     <text> "the company's web address, if the message gives one"
  linkedin:    <text> "the company's LinkedIn address, if the message gives one"
}

node Profile: "the company" {
  summary:  <text> "what the company does, in a sentence"
  sector:   <text> "the sector, in a word or two"
  location: <text> "where the company is based"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  content = [m.Body]
  map(extract(content, Company), (c) => {
    found   = research(c.name, { context: c.description, questions: "what it does, which sector it is in, where it is based", website: c.website, linkedin: c.linkedin })
    profile = extractOne([...content, Json.stringify(c), coalesce(found.dossier, "")], Profile)
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:          c.name
      Domains ?:     found.website
      Description ?: profile.summary
    }
  })
}
`,
    },
  ],
};
