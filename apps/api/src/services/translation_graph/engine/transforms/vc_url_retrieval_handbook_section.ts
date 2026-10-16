// The handbook chapter `vc_url_retrieval` declares on its manifest —
// assembled into the automation book as `plugin:vc_url_retrieval`.
//
// Kept in its own module (the knowledge-graph adapter's section sets the
// precedent) so the prose imports nothing: the plugin's own module pulls in
// the scraper and model chain, and the handbook must not.

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const VC_URL_RETRIEVAL_HANDBOOK_SECTION: HandbookSection = {
  title: 'URL retrieval — the links a message carries',
  content: `## URL retrieval — the links a message carries

\`vc_url_retrieval\` reads a piece of text, finds every link in it, works out what each one is, and loads the ones worth loading.

### where-to-put-it

\`\`\`
import { vc_url_retrieval } from plugins

pages     = vc_url_retrieval(text: msg.Body)
content   = [msg.Body, ...map(pages, (p) => coalesce(p.text, ""))]
companies = extract(content, Company)
\`\`\`

Call it once, over the message, before the extraction: the links are in the message, not in any one record, so every record the extraction produces may draw on every page. A slide deck link, a shared folder, a write-up someone linked to — all of them reach the extraction this way.

The call returns a list with one record per link it loaded, in the order it found them. Each has \`name\`, \`url\`, \`file\` and \`text\`. \`file\` is there only when the link was a document, and \`text\` only when something could be read. No link worth loading gives an empty list.

### the-downloaded-files

\`\`\`
docs = filter(pages, (p) => p.file != null)
map(docs, (p) => { write record-[:Files]-> { File ?: p.file } })
\`\`\`

A slide deck behind a link comes back as a \`file\`, so the same write that attaches an email's own files attaches it to a record. A link that was a page rather than a document has text and no file.

### scan-or-load

\`vc_url_retrieval\` decides for itself which links are worth loading. \`fetch_url\` loads exactly the one link you name. Reach for this one when the links live in the message; reach for \`fetch_url\` when the link is a field a record already carries — a company's web address, a document link extracted alongside it. Calling this one once per record loads every link in the whole message for every record.

### gated-links

\`\`\`
pages = vc_url_retrieval(text: msg.Body, email: @user_email)
\`\`\`

\`email\` is typed into a link that demands one before it will show its content. A passcode written next to a link in the text is picked up from the text itself. Without an address, a gated link is skipped rather than guessed at.

### Common mistakes

- **Extracting from the body alone when the content is behind a link.** Nothing reads the linked page unless this call loads it into the content.
- **Calling it per record to get a page per record.** It scans the whole text it is given. Name the link with \`fetch_url\` instead.
`,
  engineClaims: [
    {
      construct: 'linked pages loaded once over the message into the content, and a downloaded document attached to the record',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials
import { vc_url_retrieval } from plugins

inbox = connect email
crm   = connect attio using acme

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  summary: <text> "what the company does, from anything the pages say"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  pages   = vc_url_retrieval(text: m.Body, email: @user_email)
  content = [m.Body, ...map(pages, (p) => coalesce(p.text, ""))]
  map(extract(content, Company), (c) => {
    record = write crm-[:Companies]-> { unique by (Name), Name: c.name, Description: c.summary }
    docs = filter(pages, (p) => p.file != null)
    map(docs, (p) => { write record-[:Files]-> { File ?: p.file } })
  })
}
`,
    },
  ],
};
