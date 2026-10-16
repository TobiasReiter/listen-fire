// Manual's conceptual authoring documentation — assembled into the automation
// handbook as the `system:manual` chapter, bound by the same prose contract as
// every hand-written chapter.

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const MANUAL_HANDBOOK_SECTION: HandbookSection = {
  title: 'Run now — ad-hoc runs, text, and files (manual)',
  content: `## Run now — ad-hoc runs, text, and files (manual)

Use \`connect manual\` to let a person — or an agent — start a run by hand. "Run now", pasted text, and uploaded files all arrive as its \`Invocation\` event:

\`\`\`
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme_main } from credentials

runs = connect manual
crm  = connect attio using acme_main

node Company: "each company named in the supplied text or files" {
  name:   <text> "the company's name"
  domain: <text> "the company's web domain, if given"
}

function \`Import Companies\`(go: <runs-[:Invocation]->>) {
  found = extract([go.Text, ...go-[:Files]->.File], Company)

  map(found, (c) => {
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:    c.name
      Domains: c.domain
    }
  })
}

listen as "Import companies" to runs {} fire \`Import Companies\`
\`\`\`

- The example is the whole pattern: whatever the person supplied — \`go.Text\`, uploaded \`Files\` — goes into the extraction's content, and the writes fan out from what was found.
- Only \`Fired at\` is always present; \`Text\`, \`Run by (email)\` / \`(name)\`, and the \`Files\` edge are optional — a bare run has empty text and zero files. A \`File\` position carries \`Name\`, \`Content Type\`, \`Size\`, and the file itself.
- A backfill is this same channel with the source read in the body: \`crm-[c:Companies]-> { … }\` runs the block once per existing record. The parameter stays the \`Invocation\`.`,
  engineClaims: [
    {
      construct: 'manual-channel backfills (instance-rooted traversal in the body)',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

function \`Nightly Backfill\`(go: <runs-[:Invocation]->>) {
  crm-[c:Companies]-> {
    write c { Categories: "Reviewed" }
  }
}

listen to runs {} fire \`Nightly Backfill\`
`,
    },
    {
      construct: 'manual runs carrying text + files (reading the invocation text and extracting from the supplied files)',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

node Company: "each company named in the supplied text or files" {
  name:   <text> "the company's name"
  domain: <text> "the company's web domain, if given"
}

function \`Import Companies\`(go: <runs-[:Invocation]->>) {
  found = extract([go.Text, ...go-[:Files]->.File], Company)

  map(found, (c) => {
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:    c.name
      Domains: c.domain
    }
  })
}

listen to runs {} fire \`Import Companies\`
`,
    },
  ],
};
