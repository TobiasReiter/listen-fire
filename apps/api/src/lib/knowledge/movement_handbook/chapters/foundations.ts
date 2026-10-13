import type { Chapter } from '../types';

export const foundations: Chapter = {
  id: 'foundations',
  title: 'Foundations: what an automation is, and the one rule to get right',
  content: `## Foundations: what an automation is, and the one rule to get right

### what-an-automation-is

An automation is a small program (plain text, a \`.mvt\` file — the text is
canonical: everything the platform runs is derived from it on save). It runs
when an event reaches it — an inbound email, a changed record in a CRM, a new
row in a spreadsheet — and that event is a **position**: a point in the graph
of whichever system it came from.

Every system an automation touches is a graph — nodes joined by edges — so one
language works over all of them. From the position the event hands you, an
automation traverses to related positions, fans out across them, and reaches
into other systems' graphs, moving data between them. Almost everything else in
this handbook is a *consequence* of this, not a separate rule to memorise: when
something reads like a special case, look for the position and the edge.

### a-shareable-picture

Every automation carries a picture — a link anyone holding it can open to see
its structure: what starts it, the steps it runs, and the records it touches.
Holding the link is enough to view it; no login is required, and opening it
changes nothing. It shows structure only, never what a run has actually
captured or written, and it lives only as long as the automation it pictures —
delete the automation and the link goes with it (it can also be revoked on its
own, without deleting anything).

### language-versions

Read the two-word name on an automation — "Quiet Heron", "Bright Otter", the current "Dancing Wren" — as
the version of this language its text is written in. The automation validates,
saves and runs as that version, and an edit never changes it; a new automation
is written in the current version. So check an edit to an existing automation
as the version it is written in, not as the current one.

A warning on an automation says something keeps it on an older version: the
current version reports errors for its text, or marks a construct whose meaning
differs between the two versions, which blocks the move as surely as an error.
Other warnings, such as cost notes, never block. The automation keeps running as
it always has.

To upgrade one, repair what the current version reports — in text that still
validates as the older version — then upgrade it: the check runs again, shows
what it finds, and moves the automation only when that is clean and the move is
confirmed. Each new release moves every automation that is clean under its
current version by itself.

### the-cardinal-rule

Inbound data is rarely loose facts — it is several things that belong together:
a company, the people it introduces, the deal that connects them. So the
cardinal rule: **when records belong together, write them along their edges** —
a linked write off the parent's handle, or \`link\` to a record that already
exists:

\`\`\`
parent = write crm-[:Companies]-> {
  unique by (\`Name\`)
  Name: msg.\`Subject\`
}

write parent-[:People]-> {
  unique by (\`Email\`)
  Email: contact.email
}
\`\`\`

Never write a related record as a flat, unconnected row and hope the connection
happens by itself; it does not. Before calling an automation done, check every
record it writes ends the run attached to the records it belongs with.

### match-a-known-pattern-first

Some situations carry hard-won wording — especially the scoping language that
keeps an extraction from grabbing the wrong entities ("only the record the
message is *about*, not the ones it merely mentions"). When a brief matches a
situation the \`use-cases\` chapter covers, read it first and lift its wording
rather than re-deriving it.

### factor-variants-dont-copy

Don't copy an automation and tweak it when a new input variant needs handling.
Factor the common steps into an automation each variant calls, handing it a
\`graph<Shape> { … }\` built from whatever that variant holds (anatomy's
composition section). Two near-identical automations are a smell.

### conventions

These hold everywhere, in every chapter, and are not restated per situation:

- No magic values: every adapter, credential, and plugin name is imported;
  every other name is bound by assignment or received as a parameter.
- Everything happens on a constructed instance: parameter types, traversal
  roots, writes, and listens all name an instance you constructed
  (\`crm = attio(credentials: acme)\`) — never a bare adapter type.
- Types always wear angle brackets (\`m: <inbox-[:Email]->>\`, \`amount: <number>\`,
  \`rec IS <crm-[:companies]->>\`); positions, values, and handles never do.
  Inside a type, \`-[:…]->\` names the edge the type sits behind; \`.\` is only
  ever property access (\`msg.\`Subject\`\`, and the field tail of a borrowed
  type: \`<crm-[:companies]->.\`funding_stage\`>\`).
- Declare functions with \`function\`. Calls pass arguments in the order the
  callee declares them (\`\`Log Lead\`(msg)\`), as TypeScript calls a function;
  an adapter's and a plugin's arguments are named
  (\`fetch_url(url: c.website)\`). A function, a plugin, a built-in and a
  closure bound to a name are all called the same way, and function names are
  case-insensitive. Write your own as \`name(data…, config record, lambda)\` —
  data first, then a record of options, then a function — each left out when
  it makes no sense. Braces are declarative bodies.
- Fields read with a dot (\`msg.subject\`); "double quotes" are literal strings;
  \${…} interpolates into strings; == compares, = binds.
- Backticks wrap any name that isn't a bare identifier: a field with spaces
  (\`msg.\`Sender Name\`\`), a credential's saved name
  (\`attio(credentials: \`Acme Prod\`)\`), an automation's own name
  (\`function \`Unsnooze Actions\`(…)\`). Coin names the way the team already says
  them — \`Name: \`Subject Line\`\`, not \`Name: subject_line\` — so the brief, the
  page and the channel use the same words. Short instance names (\`crm = …\`)
  stay bare.
- \`node\` declares a shape; \`graph<Shape> { … }\` builds a record;
  \`extract(content, Shape, settings)\` extracts. Short closures take an
  expression body: \`(c) => c.name\`.
- Real names only: type, field, credential, and plugin names come from the
  live workspace catalog, never from memory or examples.
- Statements run in source order; a handle must be written before it is read.
- Entity-like targets carry \`unique by\` so repeats update instead of duplicate.

To route a situation to a chapter or section, read the handbook index — every
entry there is a fetchable \`chapter#section\`.`,
};
