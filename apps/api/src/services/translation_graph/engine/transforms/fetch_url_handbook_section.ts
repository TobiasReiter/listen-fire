// The handbook chapter `fetch-url` declares on its manifest — assembled into
// the automation book as `plugin:fetch_url`.
//
// Its own module so the prose imports nothing: the plugin pulls in the
// scraper chain, and the handbook must not.

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const FETCH_URL_HANDBOOK_SECTION: HandbookSection = {
  title: 'Fetch a page — the link a record carries',
  content: `## Fetch a page — the link a record carries

\`fetchUrl\` loads the one link you give it and returns the page's text — absent when the load failed or the page was empty.

### the-shape

\`\`\`
import { fetchUrl } from plugins

detailed = map(companies, (c) => {
  page = fetchUrl(c.website)
  return extractOne([...content, Json.stringify(c), coalesce(page, "")], CompanyDetail)
})
\`\`\`

Called inside the \`map\`, each company loads its own page, and only that company's extraction reads it. Two companies in one message get two pages. \`coalesce\` the result before it goes into content.

### when-the-field-is-empty

An empty \`url\` loads nothing: the call is absent, with no error, and is skipped for that record alone. A message naming three companies of which one has no address still produces three records — two enriched, one not.

A LinkedIn address is read as a profile: a person's profile comes back as their profile, and any other LinkedIn address — a company page, a post — comes back empty rather than as the page LinkedIn shows a stranger.

### gated-links

A shared document often arrives with its own way in written beside it: "here's the deck — docsend.com/view/abc, password SUMMER24". Extract the way in like any other field and pass it:

\`\`\`
node Opportunity: "each opportunity this message is about" {
  company:       <text> "the company's name"
  deck_url:      <text> "the link to the deck, if the message has one"
  deck_password: <text> "the passcode for that link, if the message gives one"
}

map(extract([m.Body], Opportunity), (o) => {
  deck = fetchUrl(o.deck_url, { email: @user_email, password: o.deck_password })
  …
})
\`\`\`

\`email\` and \`password\` are typed into a link that demands them before it will show its content. A link with no gate ignores both, and without them a gated link comes back empty rather than being guessed at.

Access that arrives INSIDE the content — a passcode someone wrote in a message — is data, and belongs in these arguments. The keys and tokens that let the workspace reach a connected system are held by the connection and never written in source.

### scan-or-load

\`fetchUrl\` loads one link, named. \`vcUrlRetrieval\` reads a whole piece of text, works out which of its links are worth loading, and loads all of them. Reach for this one when a record carries the address, called once per record; reach for the other when the message does.

### Common mistakes

- **Expecting two pages from one call.** It loads one. Several links in a record's own text is what scanning is for.
- **Putting the page in content raw.** It may be absent; \`coalesce(page, "")\` first.
`,
  engineClaims: [
    {
      construct: "fetchUrl called per record inside map, its page read by that record's own extraction",
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials
import { fetchUrl } from plugins

inbox = connect email
crm   = connect attio using acme

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  website: <text> "the company's web address"
}

node CompanyDetail: "the company" {
  summary: <text> "what the company does, in a sentence"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  content = [m.Body]
  map(extract(content, Company), (c) => {
    page   = fetchUrl(c.website)
    detail = extractOne([...content, Json.stringify(c), coalesce(page, "")], CompanyDetail)
    write crm-[:Companies]-> {
      unique by (Name)
      Name:           c.name
      Description ?:  detail.summary
    }
  })
}
`,
    },
    {
      construct: 'a gated link whose way in was extracted from the same message',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials
import { fetchUrl } from plugins

inbox = connect email
crm   = connect attio using acme

node Opportunity: "each opportunity this message is about" {
  company:       <text> "the company's name"
  deck_url:      <text> "the link to the deck, if the message has one"
  deck_password: <text> "the passcode for that link, if the message gives one"
}

node Raise: "the raise the deck describes" {
  raise: <text> "how much they are raising"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  map(extract([m.Body], Opportunity), (o) => {
    deck  = fetchUrl(o.deck_url, { email: @user_email, password: o.deck_password })
    terms = extractOne([m.Body, coalesce(deck, "")], Raise)
    write crm-[:Companies]-> {
      unique by (Name)
      Name:           o.company
      Description ?:  terms.raise
    }
  })
}
`,
    },
  ],
};
