import type { Chapter } from '../types';

export const anatomy: Chapter = {
  id: 'anatomy',
  title: 'Anatomy of an automation file',
  content: `## Anatomy of an automation file

Write a file (extension \`.mvt\`) in four passes, top to bottom: imports, constructions, declarations, entry points.

\`\`\`
import { email, attio } from adapters
import { acme_main } from credentials

inbox = email()
crm   = attio(credentials: acme_main)

function \`Inbound Intake\`(msg: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: msg.\`Subject\`
  }
}

listen to inbox { key: "intake" } fire \`Inbound Intake\`
\`\`\`

Imports name every external thing the file touches; constructions turn adapter types into the concrete systems ("instances") you read and write; declarations hold the automations, record structures, and file-scope values; \`listen\` lines wire an automation to what fires it (see the listeners chapter). Comments start with \`#\`.

### imports

Import from four sources, one mechanism:

\`\`\`
import { attio, email } from adapters
import { acme_main } from credentials
import { fetch_url } from plugins
import { \`Log Lead\`, Lead as \`Inbound Lead\` } from "lib/intake-routines"
\`\`\`

- \`adapters\` — adapter *types*, the kinds of system you can construct.
- \`credentials\` — your workspace's stored connections, by name.
- \`plugins\` — functions the platform ships, called with named arguments: \`page = fetch_url(url: c.website)\`.
- A quoted path — automations and record structures from another saved file. Only declarations it marks \`export\` are importable, and \`as\` renames locally.

The quoted path is the other file's saved name, matched exactly — no folders, no extension, no case-folding; \`"lib/…"\` is a naming habit, not a directory. Importing from a file changes nothing about that file: its own \`listen\` lines keep firing it, and never fire yours.

### constructions

Call an adapter type like a function to get an instance — the graph you actually read and write:

\`\`\`
crm   = attio(credentials: acme_main)
inbox = email()
\`\`\`

A credential is typed: an Attio credential cannot construct a Slack instance. Some sources are credential-free and construct with no arguments. Which record types and fields an instance offers depends on the workspace behind the credentials, so the schema is only known once it is constructed — which is why automations construct the instances they use rather than receiving them. A \`node\` you declare needs no construction: it names a structure, not a system.

Every construction takes \`dry_run\` as well:

\`\`\`
crm = attio(credentials: acme_main, dry_run: true)
\`\`\`

Writes to a dry-run instance are rehearsed — captured and reported instead of committed. Three traps:

- All-or-nothing per automation: mark every written instance \`dry_run: true\` or none; mixing them is flagged.
- A step that pauses for a person has nowhere to park in a rehearsal, so the run errors when it reaches one.
- \`sleep\` doesn't wait — it skips straight ahead.

### records-you-build

Some records exist only while the run does — one assembled from several reads, or a tidied view of what arrived. Build one with a graph literal. \`node\` only **declares** a shape; \`graph\` only **builds** a value:

\`\`\`
node Message {
  Body: <text>
  node Attachments {
    Name: <text | null>
    \`Content Type\`: <text>
  }
}

function \`Snapshot\`(m: <inbox-[:Email]->>) {
  msg = graph<Message> {
    Body: m.\`Body\`
    Attachments: m-[a:Attachments]-> {
      Name: a.\`Name\`
      \`Content Type\`: a.\`Content Type\`
    }
  }
  held = graph<Message> {
    Body: m.\`Body\`
    Attachments: m-[:Attachments]->
  }
}
\`\`\`

- **With a shape** the literal is checked as TypeScript's \`satisfies\` checks one, and the value is then of that shape. A misspelt or mistyped field is refused, naming the closest; so is a field where the shape has a nested node (or the reverse), and a required field never written. A \`<text | null>\` field may be left out.
- **Without a shape** — \`graph { … }\` — the type comes from the literal. \`graph<Shape> {}\` is the typed empty graph, valid when the shape requires no field; its nested nodes start empty.
- **The body uses a write body's syntax.** \`{ … }\` is one nested record and \`[{ … }, { … }]\` several. A path followed by a field body builds one nested record per record on the path, under the names you choose. A bare path or a record as an entry value **holds references** to the real records, as TypeScript's \`{ items: obj }\` holds \`obj\`; the shape checks them structurally, so each must have the fields its nested node needs (otherwise write the fields with a body).
- **References are live.** Reading through one sees the real record as it is now, and a write through it (a write into an edge that matches an existing child, \`write child { … }\`, \`link\`, \`unlink\`, \`delete\`) acts on that real record, exactly as through any other name holding it. New children created under the local graph's nested node stay local to the run. This lets you group records you wrote under a named nested node (\`graph<Batch> {}\`) and link or report them later.
- **Copies are snapshots.** A spread (\`graph<S> { ...r }\`) and a path followed by a field body (\`Attachments: m-[a:Attachments]-> { Name: a.Name }\`) copy, so nothing in the result points back at the source and writing to it never reaches the source. A file is held as a handle; nothing downloads.
- **\`...v\` spreads a map** (plugin output, JSON, a \`{ … }\` dict, one record) into the body. With a shape, the shape decides whether a nested map is a nested record or a value, and a map that doesn't fit fails the run naming the field. Members take effect in the order written, so a later field or spread wins; a key written before a spread that always has it is refused when you save.
- The result reads by path, \`WHERE\` and dot, takes \`write\`, \`link\` and \`delete\` like any record the run built, fits a parameter of its shape, and can be returned.
- \`both = [one, two]\` gathers records you already hold into one list, and a block head walks them in the order written: \`both-[c:company]-> { … }\`.
- Building one is not an effect. A record is copied into a system by a write: \`...n\` or \`?...n\` in the write body (see the writes chapter).

### collect-what-you-wrote

Act on everything a run wrote by collecting the handles as you write: decide what to write as values, write them in a \`MAP\` that returns each handle, then act on the result.

\`\`\`
deals = ONLY(chat-[ch:Channels WHERE \`Name\` == "deals"]->)
if deals == null { ERROR("no #deals channel") }

lines = IF msg.\`Subject\` == "urgent" THEN ["A big one just landed.", "Worth a look today."] ELSE ["A new company just landed."] END
sent  = MAP(lines, (line) => { return write deals-[:Messages]-> { Message: line } })

MAP(sent, (m) => {
  write m-[:Replies]-> { Message: "✅ filed" }
})
\`\`\`

- \`return write …\` hands back the write's handle, so \`sent\` is the records written, in order.
- A block collects the same way: \`orgs = found-[c:company]-> { return write … }\` (traversal, *what-a-block-hands-back*).

To gather records before any reach a system, declare the shape and \`write\` into its nested node:

\`\`\`
node Found {
  node companies {
    name:    <text>
    website: <text | null>
  }
}

deduped = graph<Found> {}

MAP(companies, (c) => {
  write deduped-[:companies]-> { unique by (FUZZY name), name: c.name, website ?: c.website }
})

deduped-[c:companies ORDER BY \`name\`]-> { … }
\`\`\`

- The write builds or merges by identity exactly as a write into a system does: \`unique by\` decides, and \`?:\` fills only what is absent (writes, *identity*).
- \`c = write deduped-[:companies]-> { … }\` hands back the landing, whose own nested nodes start empty and grow the same way.
- \`order by arrival\` after a nested node's closing \`}\` in the declaration keeps the order its records were written, so \`FIRST\`, \`LAST\`, \`JOIN\` and \`LIMIT\` can read it. Without it the node is a set (traversal, *record-order*).

Enrich a gathered record in place by writing to it:

\`\`\`
MAP(deduped-[:companies]->, { concurrency: 6 }, (c) => {
  details = extractOne([TEXT.SERIALISE(c, 'JSON')], Detail)
  if details != null { write c { thesis: details.thesis, website ?: details.website } }
})
\`\`\`

- \`write c { … }\` merges the named fields into the record and leaves the rest as they were; \`?:\` fills only what is empty. The record keeps its place, its nested nodes are untouched, and every later read sees the new values.
- Any name holding the record updates it: the handle a write handed back, a block's alias, a \`MAP\` parameter, a \`FIRST\`/\`AT\` pick. A record \`extract\`/\`extractOne\` handed back updates the same way. Two updates of one record take turns; updates of different records run together.
- A field the nested node does not declare is refused when you save, and so is \`write g { … }\` on a whole \`graph { … }\` value, which is not a record.

### declared-structures

Name a structure when a callee wants to say what it takes — with the same nesting the literal uses:

\`\`\`
node Deal {
  Title:  <text>
  Raised: <number>
  node company {
    Name: <text>
  }
}

function \`Process Deal\`(d: <Deal>) { … }
\`\`\`

- \`<Deal>\` types the parameter directly. A body holds typed fields and nested \`node <name> { … }\` declarations. **The nested name IS the relationship's name** — the callee walks \`d-[c:company]->\`.
- A field's type is \`<text>\`, \`<number>\`, \`<boolean>\`, \`<date>\`, \`<datetime>\`, \`<file>\`, or \`<json>\` — or borrowed from a system's field: \`Stage: <crm-[:Companies]->.Stage>\`. A field holds its type: write \`TOSTRING(n)\` or \`IF b THEN "Yes" ELSE "No" END\` into a \`<text>\` field. Add \`| null\` for a field that may be missing; it then reads \`T | absent\` wherever the declaration is used.
- **What fits is decided by structure**, never by the name. Anything carrying \`Title\` and \`Raised\` fits \`<Deal>\`. A nested node never gates the fit, and extra entries are fine.
- A declaration may say what it, each field and each nested node **is**, in the words an extraction is given: \`node Deal: "each deal in the message" { Title: <text> "its headline"; node company: "the company raising" { … } }\`. Words may interpolate file-scope values bound above the declaration.
- A declaration is not a place records live: build a \`graph<Deal> { … }\`, or write into a graph's nested node (see *collect-what-you-wrote*).

Extend a declaration when a later step needs more than an earlier one may see:

\`\`\`
node \`Recap Entry\` extends Entry {
  diverse_founder: <text | null> "whether any founder is from an under-represented group"
}
\`\`\`

\`Recap Entry\` is every field and nested node of \`Entry\`, then its own, and it goes anywhere \`Entry\` does. It only adds: restating a field \`Entry\` has is refused.

### automations

An automation is a function over a **position** — the graph point a triggering event hands it:

\`\`\`
function \`Inbound Intake\`(e: <inbox-[:Email]->>) { … }
\`\`\`

An automation wired to a \`listen\` takes **exactly one** parameter, the event position; a library function, called from other functions, takes any number. The body is statements — writes, traversal blocks, branches, assignments, and \`return\`. There is no loop construct; repetition comes from traversals and \`MAP\`.

\`=\` binds a name to a result — an instance, a write handle, an extraction, or a plain value:

\`\`\`
greeting = "New enquiry from \${msg.\`From\`}"
company  = write crm-[:Companies]-> { … }
\`\`\`

File-scope value bindings (a reusable prompt string, say) are allowed above the automations that use them.

### functions-and-calls

Declare a function with \`function\`. A closure bound to a name, a plugin and a built-in are functions too, all called the same way. Write your own to the convention every built-in follows:

\`\`\`
name(data…, config record, lambda)
\`\`\`

- **Data first**, in an order that is obvious and that the checker backs up: \`MAP(xs, { onError: 'warn' }, f)\`, \`extract(content, Shape, { tier: 'careful' })\`.
- **A config record next** for options. **A lambda last** when the function calls back into your code. Leave out whatever makes no sense. A collection is one list argument.

\`\`\`
function \`Label\`(name: <text>, tags: <text[]>, cfg: <{ prefix: text, suffix?: text }>) {
  return "\${cfg.prefix}\${name} (\${JOIN(tags, ', ')})"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  title = label(m.\`Subject\`, ["new", "inbound"], { prefix: "> " })
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: title
  }
}
\`\`\`

- **Arguments are positional**, bound to the parameters in declared order, as TypeScript calls a function. Too few or too many is refused, naming what is missing; a type mismatch names the parameter. A plugin's and an adapter's arguments are named.
- **A parameter can take a value, not only a record**: a scalar (\`<text>\`, \`<number>\`, …), a declared refinement (\`<Tone>\`), a list (\`<text[]>\`), or a config record written as a TypeScript object type (\`<{ k: T, j?: T }>\`). The argument is checked as TypeScript checks one: no key the parameter does not declare, no required key missing, and no maybe-absent value for a required parameter. Inside the function an optional key reads as possibly absent.
- **Function names are case-insensitive**: \`Label\` above is called as \`label(…)\`. Variable names keep their case.
- **Names are checked when you save.** An unknown function is refused with the closest name suggested (a write field is the exception: its target may offer functions of its own). Two functions differing only by letter case, or one named like a built-in, are refused. A name holding a value shadows a built-in, so \`upper = 3\` then \`upper(x)\` is refused.
- **A function that may wait is called on its own line**, or as the whole right-hand side of a binding (\`answer = ask_partner(c)\`) — never inside an expression. The run parks inside it however many calls deep, and resumes there.

### composition

Reuse an automation by calling it, never by copying it — from the same file, or imported from a library file:

\`\`\`
node Lead {
  Name: <text>
}

function \`Log Lead\`(l: <Lead>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: l.Name
  }
}

function \`Intake\`(msg: <inbox-[:Email]->>) {
  \`Log Lead\`(graph<Lead> { Name: msg.\`Subject\` })
}
\`\`\`

- Pass a bound name (the event, a write handle) when it already fits the parameter, or build the argument in place with \`graph<Lead> { … }\` from whatever the caller holds. Related records travel as nested nodes of that graph. A call that needs two unrelated things takes two parameters.
- A record reached by walking a collection fits a parameter typed on the listener's address for the same kind of record.
- A function that serialises or spreads a record parameter needs one whose fields the automation holds (built, extracted or written). Copy a record read from a system into \`graph<Lead> { … }\` first, or the call is refused.
- The callee sees only its parameters and ITS OWN file's top-level names. An imported function runs against its own file's imports and constructions.
- A callee's writes are recorded on the caller's run.

Mark a declaration \`export\` to share it — a function or a \`node\` structure. A file with at least one export is a **library**, and can still have listeners of its own.

### returning-a-value

Hand a result out of a body with \`return\`, and a call of that function **is** what it returned:

\`\`\`
node Doc {
  title: <text>
  node files {
    name: <text | null>
    blob: <file>
  }
}

function \`Email To Doc\`(m: <inbox-[:Email]->>) {
  return graph<Doc> {
    title: m.\`Subject\`
    files: m-[a:Attachments]-> { name: a.\`Name\`, blob: a.\`File\` }
  }
}

function \`Intake\`(msg: <inbox-[:Email]->>) {
  doc = \`Email To Doc\`(msg)
  doc-[f:files]-> {
    write drive-[:Files]-> {
      Name: COALESCE(f.name, "untitled")
      Note: doc.title
    }
  }
}
\`\`\`

- \`return\` takes any expression — a field read, a computed string, a handle, a graph. A \`return\` inside an \`if\` arm returns from the body around it.
- **Several results travel as one graph**: a field reads with a dot (\`doc.title\`), a nested node is walked (\`doc-[f:files]->\`).
- The returned value fits a parameter by **structure**, so pass the call straight in: \`log_doc(email_to_doc(msg))\`.
- A body with no \`return\` hands nothing back; binding its call is refused.

### recursion

A function may call itself, directly or through other functions — to walk a tree, an org chart, or a chain of records:

\`\`\`
function team_size(name: <text>, people: <{ name: text, manager: text }[]>): <number> {
  reports = FILTER(people, (p) => p.manager == name)
  return 1 + SUM(MAP(reports, (r) => team_size(r.name, people)))
}
\`\`\`

- **A function that calls itself declares what it returns**, after its parameters, as TypeScript requires. Leaving it out is refused, naming the loop. Any function may declare it; every \`return\` is then checked against it.
- Functions that call each other share what they do: a write or a model call in one counts for both.
- A closure bound to a name calls itself by that name: \`sum_to = (n: <number>): <number> => IF n <= 0 THEN 0 ELSE n + sum_to(n - 1) END\`.
- **Calls nest at most 32 deep** unless the installation sets otherwise; a deeper run fails, naming the chain. A \`MAP\` set to ignore or warn about failures does not swallow it.
- Every level spends against the same cost cap, and a wait deep inside resumes exactly there.

### Pitfalls

- **An automation with no effects.** A body with no \`write\`, \`link\`/\`unlink\`, or \`delete\` provisions nothing — there is nothing to run.
`,
  engineClaims: [
    {
      construct: 'recursion: a function calling itself from inside a MAP, with a declared return type',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function team_size(name: <text>, people: <{ name: text, manager: text }[]>): <number> {
  reports = FILTER(people, (p) => p.manager == name)
  return 1 + SUM(MAP(reports, (r) => team_size(r.name, people)))
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  people = [
    { name: "Ada",   manager: "" },
    { name: "Grace", manager: "Ada" },
    { name: "Alan",  manager: "Grace" },
  ]
  n = team_size("Ada", people)
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: "a team of \${n}"
  }
}
`,
    },
    {
      construct: 'function calls (composition) with a graph<Shape> argument built in place',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Lead {
  Name: <text>
}

function \`Log Lead\`(l: <Lead>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: l.Name
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Log Lead\`(graph<Lead> { Name: m.\`Subject\` })
}
`,
    },
    {
      construct: "everything a run wrote, collected by returning each write's handle from MAP, then acted on member by member",
      status: 'runs',
      probe: `
import { email, slack } from adapters
import { team_workspace } from credentials

inbox = email()
chat  = slack(credentials: team_workspace)

function \`Post And Confirm\`(msg: <inbox-[:Email]->>) {
  deals = ONLY(chat-[ch:Channels WHERE \`Name\` == "deals"]->)
  if deals == null { ERROR("no #deals channel") }

  lines = IF msg.\`Subject\` == "urgent" THEN ["A big one just landed.", "Worth a look today."] ELSE ["A new company just landed."] END
  sent  = MAP(lines, (line) => { return write deals-[:Messages]-> { Message: line } })

  MAP(sent, (m) => {
    write m-[:Replies]-> { Message: "✅ filed" }
  })
}

listen to inbox { key: "intake" } fire \`Post And Confirm\`
`,
    },
    {
      construct: "a call's value — what the callee returned, bound and passed on",
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Lead {
  Name: <text>
}

function \`Email To Lead\`(m: <inbox-[:Email]->>) {
  return graph<Lead> { Name: m.\`Subject\` }
}

function \`Log Lead\`(l: <Lead>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: l.Name
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  lead = \`Email To Lead\`(m)
  \`Log Lead\`(lead)
  \`Log Lead\`(\`Email To Lead\`(m))
}
`,
    },
    {
      construct: 'a returned graph carrying several results — one entry read by dot, one walked as an edge',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Doc {
  title: <text>
  node files { name: <text | null> }
}

function \`Email To Doc\`(m: <inbox-[:Email]->>) {
  return graph<Doc> {
    title: m.\`Subject\`
    files: m-[a:Attachments]-> { name: a.\`Name\` }
  }
}

function \`Intake\`(msg: <inbox-[:Email]->>) {
  doc = \`Email To Doc\`(msg)
  doc-[f:files]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:        COALESCE(f.name, "untitled")
      Description: doc.title
    }
  }
}
`,
    },
    {
      construct: 'multi-parameter library functions (any arity by call; entries stay arity-1)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Lead {
  Name: <text>
}

node Note {
  Text: <text>
}

function \`Persist Pair\`(c: <Lead>, n: <Note>) {
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        c.Name
    Description: n.Text
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Persist Pair\`(graph<Lead> { Name: m.\`Subject\` }, graph<Note> { Text: m.\`Subject\` })
}
`,
    },
    {
      construct: 'a graph literal TREE — a single synthesised edge, traversed by the callee',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Deal {
  Title: <text>
  node company {
    Name: <text>
  }
}

function \`Log Deal\`(d: <Deal>) {
  book = attio(credentials: acme)
  d-[o:company]-> {
    write book-[:Companies]-> {
      unique by (\`Name\`)
      Name:        o.Name
      Description: d.Title
    }
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Log Deal\`(graph<Deal> { Title: m.\`Subject\`, company: { Name: m.\`From\` } })
}
`,
    },
    {
      construct: 'a graph literal child built per record on a path (renamed landings)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Doc {
  Title: <text>
  node files {
    Label: <text>
  }
}

function \`Store\`(d: <Doc>) {
  book = attio(credentials: acme)
  d-[f:files]-> {
    write book-[:Companies]-> {
      unique by (\`Name\`)
      Name:        f.Label
      Description: d.Title
    }
  }
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Store\`(graph<Doc> { Title: m.\`Subject\`, files: m-[a:Attachments]-> { Label: COALESCE(a.\`Name\`, "untitled") } })
}
`,
    },
    {
      construct: 'a write into a nested node of a typed empty graph the run built',
      status: 'runs',
      probe: `
import { manual } from adapters

runs = manual()

node Company: "each company named in the supplied text" {
  name:    <text> "the company's name"
  website: <text | null> "its website, if given"
}

node Found {
  node companies {
    name:    <text>
    website: <text | null>
  }
}

function \`Dedupe\`(go: <runs-[:Invocation]->>) {
  deduped = graph<Found> {}

  MAP(extract([go.\`Text\`], Company), (c) => {
    write deduped-[:companies]-> {
      unique by (FUZZY name)
      name:      c.name
      website ?: c.website
    }
  })

  deduped-[c:companies ORDER BY \`name\`]-> {
    return c.name
  }
}
`,
    },
    {
      construct: 'file imports (shared movement libraries)',
      status: 'runs',
      probe: `
import { email } from adapters
import { \`Log Lead\` } from "lib/intake-routines"

inbox = email()

function \`Intake\`(m: <inbox-[:Email]->>) {
  \`Log Lead\`(m)
}
`,
    },
    {
      construct: 'graph literals — graph<Shape> with path-with-field-body children, a bare-path reference, and a spread of a map',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Message {
  Body: <text>
  node Attachments {
    Name: <text>
    \`Content Type\`: <text>
  }
}

node Setting {
  mode: <text | null>
  limit: <number | null>
}

function \`Snapshot\`(m: <inbox-[:Email]->>) {
  msg = graph<Message> {
    Body: m.\`Body\`
    Attachments: m-[a:Attachments]-> {
      Name: a.\`Name\`
      \`Content Type\`: a.\`Content Type\`
    }
  }
  copy = graph<Message> {
    Body: m.\`Body\`
    Attachments: m-[:Attachments]->
  }
  empty = graph<Setting> {}
  raw   = { mode: "fast", limit: 3 }
  cfg   = graph<Setting> { ...raw }
  loose = graph { title: m.\`Subject\` }
  msg-[a:Attachments]-> {
    write crm-[:Companies]-> { unique by (\`Name\`) Name: a.Name }
  }
}

`,
    },
    {
      construct: 'function convention — positional calls, value and record parameters, case-insensitive names',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Label\`(name: <text>, tags: <text[]>, cfg: <{ prefix: text, suffix?: text }>) {
  return "\${cfg.prefix}\${name} (\${JOIN(tags, ', ')})"
}

function \`Intake\`(m: <inbox-[:Email]->>) {
  title = label(m.\`Subject\`, ["new", "inbound"], { prefix: "> " })
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: title
  }
}

`,
    },
  ],
};
