// The handbook chapter `web-research` declares on its manifest — assembled
// into the automation book as `plugin:web_research`.
//
// Its own module so the prose imports nothing: the plugin pulls in the search
// index and the scraper chain, and the handbook must not.

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const WEB_RESEARCH_HANDBOOK_SECTION: HandbookSection = {
  title: 'Find the website — the record that arrived with no link',
  content: `## Find the website — the record that arrived with no link

\`webResearch\` works out a company's own website from its name and what the message said about it, checks the site really is that company, and loads it. Reach for it when a message names companies and only some of them come with a link.

### the-shape

\`\`\`
import { webResearch } from plugins

node Company: "each company named in this message" {
  name:        <text> "the company's name"
  description: <text> "what the message says about it"
  website:     <text> "the company's web address, if the message gives one"
  linkedin:    <text> "the company's LinkedIn address, if the message gives one"
}

map(extract(content, Company), (c) => {
  site = webResearch(c.name, { context: c.description, website: c.website, linkedin: c.linkedin })
  write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name:       c.name
    Domains ?:  coalesce(site.website, c.website)
  }
})
\`\`\`

It returns a record: \`website\`, the address it settled on, and \`text\`, the page it loaded from there. Either may be absent. Put \`site.text\` into a second extraction to read the page.

### passing-the-links

Pass the record's \`website\` and \`linkedin\` and the research stands down for any record that has one — no search, no page, nothing spent. Leave them out and it researches every record, including the ones that already have a link (load those with \`fetchUrl\`).

### the-context-is-what-makes-it-work

\`context\` is the line the message wrote about the company: what it does, where it is, who is behind it. That is what tells this company apart from every other business trading under the same word, and the research will not search without it. A record whose message said nothing beyond a name comes back with nothing, deliberately: a name alone returns the world, and the wrong website is worse than none.

Give it a real sentence and it resolves; give it a bare name and it declines. Both are correct answers, and the run record says which one happened.

### Common mistakes

- **Leaving \`context\` out.** Without it every record declines, and the call costs nothing because it does nothing.
- **Dropping the resolved address.** Write \`site.website\`, or nothing downstream has it.
`,
  engineClaims: [
    {
      construct: 'webResearch called per record beside a targeted fetch, the resolved address written and the page read by a second extraction',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials
import { fetchUrl, webResearch } from plugins

inbox = connect email
crm   = connect attio using acme

node Company: "each company named in this message" {
  name:        <text> "the company's name"
  description: <text> "what the message says about it"
  website:     <text> "the company's web address, if the message gives one"
  linkedin:    <text> "the company's LinkedIn address, if the message gives one"
}

node Profile: "the company" {
  summary: <text> "what the company does, in a sentence"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  content = [m.Body]
  map(extract(content, Company), (c) => {
    page    = fetchUrl(c.website, { email: @user_email })
    site    = webResearch(c.name, { context: c.description, website: c.website, linkedin: c.linkedin })
    profile = extractOne([...content, Json.stringify(c), coalesce(page, site.text, "")], Profile)
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:          c.name
      Domains ?:     coalesce(site.website, c.website)
      Description ?: profile.summary
    }
  })
}
`,
    },
  ],
};
