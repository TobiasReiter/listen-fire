import type { Chapter } from '../types';

export const writes: Chapter = {
  id: 'writes',
  title: 'Writes, handles, and identity',
  content: `## Writes, handles, and identity

Use \`write\` to create or update a record in another system.

### writes

\`\`\`
company = write crm-[:Companies]-> {
  unique by (\`Domains\`)
  Name:    AI("the company name this email is about")
  Domains: [msg-[:Sender]->.domain]
}
\`\`\`

- The body maps the target's **writable fields** to expressions — only fields it declares, so read the schema rather than guess. Fill every one the source supports, and never invent a value to fill a slot.
- \`unique by (…)\` gives the record its identity, so a repeat event updates instead of duplicating.
- \`...e\` writes every **field** of \`e\` as if each were its own line (\`name: e.name\`, \`stage: e.stage\`, …) — never its nested nodes, which are writes of their own. \`e\` is a record whose fields the automation spells out: an extracted record, a parameter typed on a declaration (\`d: <Deal>\` spreads exactly \`Deal\`'s fields), a graph you built, or a record you wrote — however the name came to hold it (a \`FIRST\` pick, a \`MAP\` parameter, a map's key: \`...m.k\`). A record read from a system is written field by field. A field the target lacks is flagged by name, and so is one that may be absent (use \`?...e\`, below). An explicit line for a field wins over the spread's value for it.
- The assignment gives you a **handle**: a position in the target's graph carrying the written fields plus results like \`externalId\` and \`url\`, read like any position (\`company.url\`).
- A target may declare fields and connections its type **cannot exist without**; omit one and the write is flagged before it runs. Fix a missing connection by moving that parent into the write target (linked or tuple form, below); wrap a required field's \`AI()\` in \`COALESCE\`, since it can resolve to null.

### what-the-write-did

A handle carries what the write actually did, so a later message can say it honestly:

\`\`\`
Message: IF company.created THEN "Added \${company.\`Name\`}"
                            ELSE "Updated \${company.\`Name\`}" END
\`\`\`

\`created\` is \`TRUE\` when the write minted a new record, \`FALSE\` when it matched an existing one. \`committed\` is \`TRUE\` when it landed in the target system, \`FALSE\` when the instance was only rehearsing (\`dry_run: true\`).

### set-if-empty

\`?:\` sets a field **only when the target's current value is empty** — null or absent; an empty string counts as a value.

\`\`\`
write crm-[:Companies]-> {
  unique by (\`Name\`)
  Name:          msg.\`Subject\`
  Description ?: "Owner: \${@user_email}"
}
\`\`\`

Use it for defaults and one-time stamps — owners, "first seen" — and plain \`:\` where the source stays authoritative. \`?:\` also takes a value that may not be there, no guard needed: \`Description ?: FIRST(company.Domains)\`.

\`?...e\` applies \`?:\` to every field of \`e\` — the whole record merged into what the target already holds, filling only what is empty: \`write crm-[:Companies]-> { unique by (FUZZY \`Name\`), ?...e }\`.

### append-to-a-multi-value-field

A plain \`:\` on a multi-valued field **replaces** the whole list. To add to it:

\`\`\`
Categories  +: ["inbound"]
Categories +?: [AI("a one-word category for this lead")]
\`\`\`

\`+:\` appends, duplicates and all; \`+?:\` appends only what's missing, so re-running never piles up duplicates. Both need a list — on a single-valued field they're flagged at save. Pair them with \`unique by\`, or the repeats land on different records with nothing to accumulate into.

A create writes into empty slots, so there every modifier — \`?:\`, \`+:\`, \`+?:\` — behaves like a plain \`:\`.

### structured-values

A few fields take a **structured value** — an object with named keys, nested as deep as it needs, because the target publishes its own document format. Write it inline as a literal, keys separated by commas:

\`\`\`
Layout: {
  heading: "\${company.\`Name\`} is ready",
  blocks: [{ kind: "text", value: "Approved by \${@user_email}" }]
}
\`\`\`

Nothing checks inside it — copy the shape from that system's documentation; a document it dislikes is its complaint at run time. **Opaque means pass-through and nothing else**: with no known shape the value can't be compared, added to, folded into a message, counted, or used as a condition, and each of those is refused as you write it.

### identity

\`\`\`
unique by (\`First Name\`, \`Last Name\`)
\`\`\`

- One clause is an AND-group — this one matches only when *both* do. Two clauses mean OR: match if either rule does.
- A component may be a **handle** rather than a field: \`unique by (parent, \`Stage\`)\` scopes identity to a parent, the way an order is unique *within* its customer.
- \`FUZZY\` matches a component by *similarity*: \`unique by (FUZZY \`Name\`)\` treats "Acme, Inc." and "Acme Inc" as one company. Use it on names and labels, never on ids or emails; not every target offers it.
- A \`FUZZY\` match is settled in two steps: the target surfaces the candidates by its own means, and a judge picks the best one, if any. A record the run built judges the same way.
- A component may pin a value: \`unique by (parent, \`Stage\` == "Seed")\` matches only a record whose Stage is Seed.
- A component that is not an equality narrows the candidates after the lookup: \`unique by (\`Name\`, \`Updated\` WITHIN 30d)\` matches by Name, and only a record updated in the last 30 days. With several \`unique by\` lines, each line's test narrows only the records its own key found.
- Such a test reads only the candidate's own fields, and a candidate without the field fails it unless the test is \`!=\`. To test anything else (a hop such as \`EXISTS(…)\`, a value from earlier in the run), use a \`WHERE\` on the target instead.

Identity at write time is the **union** of the target's own rules and your \`unique by\`, so author only the identity the target lacks: compound business keys, parent-scoped identity, fields it treats as ordinary.

### match

Use \`match\` to find a record you will not create:

\`\`\`
company = match crm-[:Companies]-> {
  unique by (FUZZY \`Name\`)
  unique by (\`Domains\`)
  Name:    AI("the company name this email is about")
  Domains: [msg-[:Sender]->.domain]
}
\`\`\`

- The identity clauses work as in \`write\`: two clauses mean either, so this finds the company by a similar name or by its domain.
- The fields are the values to match on, and nothing is written, so \`?:\`, \`+:\` and \`+?:\` are refused.
- The lines after it run only when the record exists. On a miss the enclosing scope ends quietly: that iteration skips, or the run stops after the work already done.
- Written without a name (\`match crm-[:Companies]-> { … }\`), it is a gate: the rest of the block runs only if the record is there.
- The handle reads like a write's, without \`created\` and \`committed\`. A polymorphic edge takes the type explicitly: \`match a-[:related]-><Companies> { … }\`.
- A \`WHERE\` on the target's hop says which existing records may be matched: \`match crm-[c:Companies WHERE EXISTS(c-[:Team]->)]-> { … }\` considers only companies with someone on their team. Each candidate is read the way a traversal's \`WHERE\` reads a record, before the identity is settled. On \`write\` the \`WHERE\` limits what may be updated, never whether to write: with no candidate left, the write creates.
- Use \`write … unique by\` instead when the record should be created if it is missing.

\`FUZZY\` works only on the fields a target lists for similarity, and the save check names them. A valuations Legal Entity lists \`Name\`, \`Legal Name\`, \`Also Known As\` and \`Other Names\`: its shortlist searches the words in all four, plus near spellings of \`Name\` and \`Legal Name\`. Every other field matches exactly, and \`Website\` ignores the scheme, \`www.\` and a trailing slash.

### linked-writes

When the new record should hang off one you just wrote, target **an edge from the handle**:

\`\`\`
company = write crm-[:Companies]-> { unique by (\`Name\`), Name: enquiry.\`Company Name\` }

write company-[:Team]-> { Name: enquiry.\`Contact Name\` }
\`\`\`

One effect, two assertions: the record *and* its link from \`company\`. The type comes from the edge, so the child can't be authored without its connection. Chains compose, which is why you write parents first: every child hangs off a handle already in hand.

A parent is a name or a member path: \`write m.k-[:Team]-> { … }\` hangs the child off the record a map's key holds. Bind any other expression to a name first.

The edge may be declared on **either side**: where only the child references back, write it at the root and \`link\` it instead. Never put a handle in a reference-shaped *field* (\`Partner: pa\`) — connections live in the write target, not the body.

### conversation-writes

Posting to a chat system needs no special "send": a message is a record written along an edge, the same one you read coming in. What changes is only **what it hangs under** — its channel or thread comes from its parent, never from a field you fill in.

\`\`\`
deals = ONLY(chat-[ch:Channels WHERE \`Name\` == "deals"]->)
if deals == null { ERROR("no #deals channel") }
write deals-[:Messages]-> { Message: "A new company just landed." }

write msg-[:Replies]-> { Message: "Got it — taking a look now." }
\`\`\`

A reply hangs under the message that fired the automation, or one an earlier write sent back. What a system calls its message field, and which further edges it offers, is in that system's own chapter.

### multi-parent-writes

Some records sit at the convergence of *several* parents, none primary. Write the record once, with a **tuple of paths**:

\`\`\`
write (co-[:agreements]->, pa-[:agreements]->) {
  unique by (co, pa)
  Value: msg.\`Value\`
}
\`\`\`

Each path is a handle plus one edge its type declares, and the written type must be the **same** for every path: one record carrying N connections, not N records, created in one effect. \`unique by (co, pa)\` scopes its identity by all the parents at once.

### link

\`link\` connects two records **without creating or modifying either one**.

\`\`\`
link champion -[:led]-> part

c = link p -[:Company]-> { unique by (FUZZY \`Name\`), Name: "Acme" }
\`\`\`

The first form joins two handles in the same graph, over an edge the from-side declares. The second takes a \`match\` body: it is \`c = match p-[:Company]-> { … }\` then \`link p -[:Company]-> c\`, and written without a name it links without binding. \`Name\` selects Acme, it doesn't rename anything, and a miss skips the \`link\` with the rest of the scope.

A link body with no \`unique by\` identifies by all of its fields, exactly: \`link p -[:Company]-> { Name: "Acme", City: "Berlin" }\` finds the company whose Name and City both agree.

### looking-up-existing-records

Look up a record that must already exist with \`ONLY\`, and guard it:

\`\`\`
company = ONLY(crm-[c:Companies WHERE \`Domains\` CONTAINS "acme.com"]->)
if company == null { ERROR("no company at acme.com") }
write company-[:Notes]-> { Title: "Enriched", Content: "found \${company.Name}" }
\`\`\`

The hop's \`WHERE\` is the criteria, rooted at any instance in scope. The guard ends the run with a reason when nothing matches.

So: a lookup finds a record that must be there, and a miss fails the run; \`match\` finds one that may not be, and a miss skips the rest of the scope; \`write … unique by\` finds *or creates*; \`write <alias>\` updates the exact record you already hold.

### updating-a-record-in-place

\`\`\`
crm-[record:Companies WHERE \`Categories\` == "Lead"]-> {
  write record { Categories: "Customer" }
}
\`\`\`

\`write <alias> { … }\` updates the record the alias already stands on — traversed, or a handle from earlier in the run — and \`write m.k { … }\` updates the one a map's key holds, as \`x = m.k\` then \`write x { … }\` would. Nothing is left to resolve, so \`unique by\` is rejected, and there is no create to gate: set only the fields that change, and use \`link\`/\`unlink\` for connections. A target that can't update by id (an append-only channel, a drive that only creates files) is flagged at save.

### removal

\`\`\`
unlink company -[:related]-> stale     # sever the edge; both records remain
delete stale                           # remove the record itself
\`\`\`

\`unlink\` is the exact inverse of \`link\`'s handle form; severing an edge that isn't there is a quiet no-op. \`delete\` removes the record a position stands on, so it works wherever an in-place update does — reach for it only when removal is the point, never as cleanup for an identity you got wrong. Both are capability-gated: a target that can't sever or delete rejects the statement up front.`,
  engineClaims: [
    {
      construct: 'bare-handle link statements between written handles',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  a = write crm-[:Companies]-> { Name: m.\`Subject\` }
  b = write crm-[:People]-> { Name: m.\`From\` }
  link a -[:employs]-> b
}
`,
    },
    {
      construct: 'match statements (find by identity, binding the found handle), then link',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  person = write crm-[:People]-> { unique by (\`Job Title\`), Name: m.\`From\` }
  employer = match person-[:Company]-> { unique by (\`Name\`), Name: "Acme" }
  link person -[:Company]-> employer
  write employer-[:Notes]-> { Title: "Introduced", Content: m.\`Subject\` }
}
`,
    },
    {
      construct: 'link with a match body (match then link), bound and unbound, with and without unique by',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  person = write crm-[:People]-> { unique by (\`Job Title\`), Name: m.\`From\` }
  employer = link person -[:Company]-> { unique by (FUZZY \`Name\`), Name: "Acme" }
  link person -[:Company]-> { Name: m.\`Subject\` }
  write employer-[:Notes]-> { Title: "Introduced", Content: m.\`Subject\` }
}
`,
    },
    {
      construct: "a WHERE on a match target's hop, narrowing which existing records may be matched",
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  company = match crm-[c:Companies WHERE EXISTS(c-[:Team]->)]-> {
    unique by (FUZZY \`Name\`)
    Name: m.\`Subject\`
  }
  write company-[:Notes]-> { Title: "Seen again", Content: m.\`Subject\` }
}
`,
    },
    {
      construct: 'unbound match as a gate, with FUZZY and two OR-ed identity clauses',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  match crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    unique by (\`Domains\`)
    Name:    m.\`Subject\`
    Domains: [m.\`From\`]
  }
  write crm-[:People]-> { unique by (\`Name\`), Name: m.\`From\` }
}
`,
    },
    {
      construct: 'tuple-path multi-parent writes',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  co  = write crm-[:Companies]-> { unique by (\`Name\`), Name: m.\`Subject\` }
  inv = write crm-[:Investors]-> { unique by (\`Name\`), Name: m.\`From\` }
  write (co-[:investments]->, inv-[:investments]->) {
    unique by (co, inv)
    Amount: m.\`Body\`
  }
}
`,
    },
    {
      construct: "the '?:' set-if-empty field marker",
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:          m.\`Subject\`
    Description ?: "Owner: \${@user_email}"
  }
}
`,
    },
    {
      construct: "the '+:' / '+?:' append field markers (multi-value merge)",
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    unique by (\`Domains\`)
    Name:          m.\`Subject\`
    Domains:       m.\`From\`
    Categories  +: ["inbound"]
    Categories +?: [m.\`Subject\`]
  }
}
`,
    },
    {
      construct: 'in-place update of a traversed record (`write <alias> { … }`)',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Reactivate\`(go: <runs-[:Invocation]->>) {
  crm-[record:Companies WHERE \`Categories\` == "Lead"]-> {
    write record { Categories: "Customer" }
  }
}

listen to runs {} fire \`Reactivate\`
`,
    },
    {
      construct: 'a WHERE-filtered lookup over the source graph, bound with ONLY and guarded (the exact-lookup idiom)',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Enrich\`(go: <runs-[:Invocation]->>) {
  company = ONLY(crm-[c:Companies WHERE \`Domains\` CONTAINS "acme.com"]->)
  if company == null { ERROR("no company at acme.com") }
  write company-[:Notes]-> { Title: "Enriched", Content: "found \${company.Name}" }
}

listen to runs {} fire \`Enrich\`
`,
    },
    {
      construct: 'unlink statements between written handles',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  a = write crm-[:Companies]-> { Name: m.\`Subject\` }
  b = write crm-[:People]-> { Name: m.\`From\` }
  unlink a -[:employs]-> b
}
`,
    },
    {
      construct: 'delete statements over written handles',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  stale = write crm-[:Companies]-> { Name: m.\`Subject\` }
  delete stale
}
`,
    },
    {
      construct: "'?:' discharging a FIRST()-bound value that may be absent, no guard needed",
      status: 'runs',
      probe: `
import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

function m(evt: <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->>) {
  evt-[co:Companies]-> {
    domain = FIRST(co.Domains)
    write co { Description ?: domain }
  }
}
`,
    },
    {
      construct: 'traversing edges onward from a write handle (block head and expression form)',
      status: 'runs',
      probe: `import { manual, attio } from adapters
import { acme_main } from credentials
runs = manual()
crm  = attio(credentials: acme_main)
function m(go: <runs-[:Invocation]->>) {
  co = write crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    Name: "Acme"
  }
  co-[p:Team]-> {
    write co-[:Notes]-> { Title: "Team member", Content: p.\`Name\` }
  }
  write co-[:Notes]-> { Title: "Team", Content: "\${co-[:Team]->.\`Name\`}" }
}
listen to runs {} fire m
`,
    },
  ],
};
