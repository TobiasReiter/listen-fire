// The knowledge graph's conceptual authoring documentation — doc tier 3: what
// an author should know about the graph BEFORE building against it. Assembled
// into the automation handbook as the `system:kg` chapter, and bound by the
// same contract as every hand-written chapter (consumer-
// neutral prose, no internal vocabulary, every runnable example backed by a
// checked probe).
//
// A sibling file rather than a `knowledge_graph/` directory: the KG adapter is
// a single module with flat siblings (writes, resources, uniqueness), so the
// section follows that shape instead of importing a directory the rest of the
// adapter does not have.
//
// The examples name `graph` for the constructed instance and `Company`,
// `Person`, `Support Ticket` for the types — a REPRESENTATIVE
// ontology, not a fixed one. The graph's types are whatever the team's own
// data model declares, which is exactly the point the `your-own-types` section
// makes; the handbook's checker fixture carries the same shape so the probes
// below check against it.

import type { HandbookSection } from 'movement-engine/lib/handbook_section';

export const KNOWLEDGE_GRAPH_HANDBOOK_SECTION: HandbookSection = {
  title: 'Knowledge graph — the workspace\'s own store',
  content: `## Knowledge graph — the workspace's own store

Import the graph and name it, the same two lines every system takes:

\`\`\`
import { \`@lf/kg\` as kg } from adapters

graph = connect kg
\`\`\`

That is the whole setup — no credentials to paste and nothing to connect, because the graph is part of Listen-Fire rather than somewhere else. The name is yours: \`graph\` is what every walk, write and listener below spells, and another automation may pick a different one. It is the same store either way.

### your-own-types

The types you write against are the team's own data model — the same records a person browsing the workspace sees, not a vendor's fixed surface. So \`Company\` and \`Support Ticket\` below are illustrations; read the live model for the real ones exactly as you would for any connected system.

A type whose name has a space wears backticks, like any other name:

\`\`\`
graph-[c:\`Support Ticket\` WHERE c.Status == "Open"]-> { … }
\`\`\`

Everything else about the graph is what you already know: it is walked, filtered, written, and listened to with the ordinary spellings. What follows is only where it differs.

### writing-records

Write along the type, off the graph:

\`\`\`
co = write graph-[:Company]-> {
  unique by (FUZZY Name)
  Name:    company.name
  Domains: company.domain
}

write co-[:Team]-> {
  unique by (co, Name)
  Name:  person.name
  Email: person.email
}
\`\`\`

- The first write is rooted at the graph; the second hangs off the handle the first returned, so the person is created **and** attached to the company in one step. That is the cardinal rule, unchanged.
- \`unique by (co, Name)\` names the parent handle as part of the identity: two people called the same thing at different companies stay two records, and re-running the automation updates rather than duplicates. A bare field (\`unique by (FUZZY Name)\`) identifies across the whole type.
- Leave \`unique by\` off and the type's own identity rules still apply — the model may already declare what makes a record unique. Where it declares nothing, every write creates a new record, so say what identity means whenever a later event can mention the same thing again.

### connecting-what-already-exists

Where both records are already in the graph, assert the edge rather than writing through it:

\`\`\`
person = only(graph-[p:Person WHERE p.Email == msg.From]->)
if (person == null) { fail("no person with email \${msg.From}") }
link co-[:Team]-> person
\`\`\`

Asserting an edge that is already there changes nothing, so this is safe to re-run. Edges read and write from either end — the model names both directions, and you may write along whichever one reads better.

### running-when-the-graph-changes

Run an automation whenever a record in the graph changes, whoever changed it:

\`\`\`
function \`Announce The Ticket\`(change: <graph-[r:\`Record Change\` WHERE r.type == "Support Ticket" AND r.action == "record.updated"]->>) {
  general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  change-[ticket:Record]-> {
    write general-[:Messages]-> { Message: "Ticket now: \${ticket.Status}" }
  }
}

listen to graph { type: "Support Ticket", events: ["record.updated"], fields: [Status] } fire \`Announce The Ticket\`
\`\`\`

What arrives is the CHANGE, not the record. A \`Record Change\` says which type changed and how; the record it happened to is one hop away, over \`Record\`. Every system whose changes can start an automation hands them over this way, so the shape is the one you already know.

- \`type\` is required, and names the watched type in quotes. The parameter pins the same name, which is what lets the record one hop along carry that type's properties.
- \`events\` narrows to \`"record.created"\`, \`"record.updated"\`, \`"record.deleted"\` — omit it for all three.
- \`fields\` narrows updates to the properties you care about, named bare. They are properties of the RECORD, and an update that touched nothing on the list does not fire.
- A deleted record has nothing left to read, so \`Record\` is not there on a delete. Pin \`action\` as above, or test with \`is\` before walking it.
- A run that both listens to the graph and writes to it can wake itself. Narrow the listener to the types and fields you actually mean; where an automation should ignore its own writes and react only to everyone else's, add \`suppress_self: true\`.

### when-the-graph-and-when-the-other-system

Both are places records live, so the question is which one owns the answer. A connected system is somebody else's shape: its fields, its rules, and the place the team already works — mirror into it when the record is the team's operational truth, and accept the shape you find. The graph is shaped by you, and holds what no single system does: what several sources agreed, what an automation worked out, the connections that span systems. Reach for it when the thing you want to keep has nowhere else to live, and mirror outward when someone needs it where they already are.`,
  engineClaims: [
    {
      construct: 'a knowledge-graph root write with fuzzy identity, plus a linked write scoped to its parent',
      status: 'runs',
      probe: `
import { \`@lf/kg\` as kg, \`@lf/email\` as email } from adapters

inbox = connect email
graph = connect kg

node Company: "the company this message is about" {
  name:   <text> "the company's name"
  domain: <text> "the company's web domain, if given"
  node person: "each person named for that company" {
    name:  <text> "their full name"
    email: <text> "their email address, if given"
  }
}

function \`Record The Company\`(msg: <inbox-[:Email]->>) {
  c = extractOne([msg.Body], Company)
  if (c == null) { fail("no company in this message") }

  co = write graph-[:Company]-> {
    unique by (FUZZY Name)
    Name:    c.name
    Domains: c.domain
  }

  c-[p:person]-> {
    write co-[:Team]-> {
      unique by (co, Name)
      Name:  p.name
      Email: p.email
    }
  }
}

listen to inbox { key: "intake" } fire \`Record The Company\`
`,
    },
    {
      construct: 'a knowledge-graph mutation listener — the event position, the hop to the changed record, and field narrowing',
      status: 'runs',
      probe: `
import { \`@lf/kg\` as kg, \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace
graph = connect kg

function \`Announce The Ticket\`(change: <graph-[r:\`Record Change\` WHERE r.type == "Support Ticket" AND r.action == "record.updated"]->>) {
  general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  change-[ticket:Record]-> {
    write general-[:Messages]-> {
      Message: "Ticket now \${ticket.Status}."
    }
  }
}

listen to graph { type: "Support Ticket", events: ["record.updated"], fields: [Status] } fire \`Announce The Ticket\`
`,
    },
    {
      construct: 'a knowledge-graph rooted read — query the graph, walk an edge off the landing, and link an existing record',
      status: 'runs',
      probe: `
import { \`@lf/kg\` as kg, \`@lf/slack\` as slack, \`@lf/manual\` as manual } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace
runs = connect manual
graph = connect kg

function \`Weekly Graph Digest\`(go: <runs-[:Invocation]->>) {
  lines = graph-[c:Company WHERE c.Stage == "Active" ORDER BY c.Name ASC LIMIT 10]-> {
    graph-[p:Person WHERE p.Email == go.Text]-> {
      link c-[:Team]-> p
    }

    return "\${c.Name} — \${count(c-[:Team]->)} on the team"
  }

  general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  write general-[:Messages]-> {
    Message: "Active companies:\\n\${Text.join(lines, "\\n")}"
  }
}

listen to runs {} fire \`Weekly Graph Digest\`
`,
    },
  ],
};
