import type { Chapter } from '../types';

export const traversal: Chapter = {
  id: 'traversal',
  title: 'Traversal blocks — doing something per related position',
  content: `## Traversal blocks — doing something per related position

Do something per related position by following a path with a block: **any position-valued path followed by a block runs the block once per position the path yields.** Two attachments → the block runs twice; none → it doesn't run at all. That is the language's only repetition — there is no loop construct.

### blocks

\`\`\`
msg-[a:Attachments]-> {
  write drive-[:file]-> {
    Name: a.Name
    Data: a.Data
  }
}
\`\`\`

- The head is a traversal: \`-[:edge]->\` relative to the enclosing position, or rooted at any in-scope name (\`deals-[c:Companies]->\`, chaining hops as usual).
- Head the block at an EXPRESSION that ends in a record, and skip the binding: \`rows[0]-[c:company]-> { … }\` walks exactly as naming the call first and hopping off the name does. The expression ends at the first \`-[\` outside its own brackets, so a hop written inside it belongs to it (\`only(found-[c:company]->)-[f:founder]->\`).
- The bracket-alias (\`a\`, \`c\`) names *this iteration's* position inside the block. Aliases are lexically scoped to their block.
- A \`WHERE\` filter on the hop narrows which positions the block sees: \`msg-[f:attachments WHERE f.\`Content Type\` == "application/pdf"]-> { … }\`. Inside it, a field is read through the hop's own alias, and a bare name is an outer variable.
- Pick one member of an edge that holds several kinds by testing its label in the \`WHERE\`: \`o-[le:\`List Entries\` WHERE le.listName == "Deal Pipeline" AND le.\`Deal Created\` >= cutoff]-> { … }\`. The whole \`WHERE\` narrows the hop to that list, whatever order its tests are in, so the list's own fields read in the \`WHERE\` and off \`le\`. Without that test the hop carries only what every list shares, and reading one list's field is refused, naming the test to add.
- Blocks nest: a block over companies can contain a block over each company's rounds. With nesting, write the inner record as a **linked write** from the enclosing handle so the structure lands connected (see the writes chapter).

A handle is already a position — "continue from the company I just wrote" needs no construct: expressions rooted at the handle read its own fields directly, and traversing further *edges* onward from it walks just like any other position (\`co-[n:Notes]-> { … }\`, \`"\${co-[:Notes]->.Content}"\`).

### query-a-graph

A constructed instance can root a traversal directly. The first hop names a collection, and the bracket takes the full query surface: \`WHERE\` to filter, \`ORDER BY\` to sort by a field of the hop target, \`LIMIT\` to take the top N.

\`\`\`
# The ten most recent Customer companies in the CRM, one block run each:
crm-[c:Companies WHERE c.Categories == "Customer" ORDER BY c.\`Created At\` DESC LIMIT 10]-> {
  …
}

# The same surface works in expressions and conditions:
Message: "Top company: \${crm-[c:Companies ORDER BY c.\`Team Size\` DESC LIMIT 1]->.Name}"
if (exists(crm-[c:Companies WHERE c.Domains CONTAINS m.sender_domain]->)) { … }

# Sort by something one hop along — the bracket's alias names the record being ranked:
crm-[p:People ORDER BY p-[:Company]->.Name]-> { … }
\`\`\`

- \`ORDER BY\` names a field of the records the hop yields, through the alias (backticked only if the name has spaces); \`ASC\` is the default, \`DESC\` reverses. Records with an empty sort field sort last either way.
- The sort key can be any expression over the record being ranked, not just one of its fields: a short path through a single reference (\`p-[:Company]->.Name\`), or a value built from its fields. A key that reads a field the source can sort by is done at the source; anything else is read record by record here, and you get a note saying so. A key that answers with several values, or one that calls \`ai\`, is refused — a record needs one value to be ranked by.
- \`LIMIT n\` keeps the first n after sorting, so pair it with an \`ORDER BY\` unless the relationship is ordered by nature (see *record-order* below). On a multi-hop path it bounds which records the NEXT hop continues from.
- A source that can filter, sort, or limit in its own query API does the work there; where it can't, the platform does it over the records the hop yields. The answer is identical either way — what changes is how much the source has to hand over. The one exception is a record missing the field a test reads: run here, \`!=\` keeps it (a missing value is never equal to one that is there), but a source doing the test in its own query may treat a missing field its own way.
- When part of a \`WHERE\` narrows at the source and part of it doesn't, you get a note saying which test is left over and running here. It is a cost, not a mistake: the records are the same, the fetch is bigger. Move the leftover test onto a field the source can search if the fetch matters. Where *nothing* in the \`WHERE\` narrows at the source, the hop is refused instead — that is the whole collection coming over the wire, which is a different thing.
- A collection a source can search but not sort gives you the same kind of note about the \`ORDER BY\`: it runs here, over everything the \`WHERE\` let through — unless it names the order the source already answers in (a mailbox's \`Date\` \`DESC\`), which is done at the source, \`LIMIT\` and all, with no note. The order is the one you asked for; the fetch is bigger. Narrow the \`WHERE\` further if it matters.
- A collection whose source can't narrow at all gives you the same kind of note about the \`WHERE\` itself: it runs here, over the whole collection fetched first. The records are the WHERE's answer either way; the fetch is bigger.
- An instance-rooted hop with no \`WHERE\` and no \`LIMIT\` reads the collection *whole*, page after page. Nothing caps it, so scope it unless you genuinely mean every record.

### record-order

\`\`\`
# Some relationships are ordered by nature — a channel hands its messages back
# oldest-first, an email its attachments in the order it carried them.
Message: "\${Text.join(ch-[m:Messages LIMIT 20]->.Text, "
")}"

# Everywhere else, say what you mean.
Message: "\${Text.join(crm-[c:Companies ORDER BY c.\`Created At\` DESC LIMIT 5]->.Name, ", ")}"

# One record, however they come back.
channel = only(chat-[ch:Channels WHERE ch.Name == "alerts"]->)
\`\`\`

A relationship either hands its records back in an order that means something or it doesn't, and the difference decides which aggregates may read it.

- \`Text.join\`, \`first\` and \`List.last\` read a sequence. Over a relationship with no order and no \`ORDER BY\` they are refused while you write, with the fixes named.
- \`only(<walk>)\` is *the one that matched* — the spelling for a lookup. It hands back that record (or that value), and fails the run if there turns out to be more than one. It makes no claim about order, so it is what a \`WHERE\` narrowing to a single record wants.
- \`count\`, \`List.sum\`, \`List.avg\`, \`List.min\`, \`List.max\` and \`List.from\` give the same answer whatever the order, so they read either.
- \`LIMIT n\` with no \`ORDER BY\` means *some n of them*, and is refused for the same reason — except over a relationship ordered by nature, where "the latest twenty" is exactly what it says.

Which relationships are ordered is the source's own fact, and each one says: chat messages and thread replies by time, a curated list's entries by when they were added, a document's sections and an email's attachments by their place in it, answers and callback fires by when they landed.

### what-a-source-can-filter

Expect the filter surface to differ per source. A CRM might filter companies by a categorised field at its query API but not by a long free-text one; a record's handful of related rows can be filtered on anything, because the set is already small. Each source declares — per relationship and per field — what it can do:

- Filter or sort by something the source can't, and you get an error **while authoring**, with the reason ("this source can't filter Companies by that field — it isn't filterable at the source"). You re-shape the automation then and there — never a silent, ruinous full read at run time.
- A filter that needs in-app judgement — \`ai(...)\` or \`exists(...)\` — can run only over a **bounded** relationship (a record's few related rows), where judging each one in-app is cheap. Over an unbounded collection it's blocked: the platform can't be told to read millions and judge each. Narrow to a bounded relationship first, then judge.
- \`WITHIN\` filters by recency — \`c.\`Created At\` WITHIN 30d\` keeps records from the last 30 days (\`d\` days, \`h\` hours, \`w\` weeks).

What you can write against a source is the overlap of the language and that source's own abilities; you learn where that overlap ends while authoring, not in production.

### what-a-block-hands-back

Hand a value out of a block with \`return\`, and bind the block to collect what its iterations returned:

\`\`\`
names = mentioned-[c:company]-> {
  return c.name
}

Message: "Logged \${Text.join(names, ", ")}"
\`\`\`

\`return\` runs once per position the head yields, so the binding is all of them together. What that collection is follows from what you returned:

- a plain **value** — a name, a number, a composed line — gives a **list**, one entry per iteration, ready for \`Text.join\`, \`count\`, or an options list;
- a **record** — a write's handle, a traversed position, a graph — gives those records themselves, walked and read like any other position.

\`\`\`
orgs = mentioned-[c:company]-> {
  return write crm-[:Companies]-> { unique by (\`Name\`), Name: c.name }
}

Message: "Logged \${count(orgs)} companies"
\`\`\`

- \`return\` may sit anywhere in the body, including inside an \`if\` arm — that arm's \`return\` is the block's. Every iteration hands back the same kind of thing.
- The list is in the head's order: order the head (or head it on a relationship ordered by nature) whenever you \`Text.join\` what comes back.
- A block that ran zero times hands back an empty list, so \`count(names)\` is \`0\` rather than an error.
- To hand back several things at once, return a dict (\`{ name: c.name, size: c.size }\`) or a graph; the entries then read by name.
- A body with no \`return\` hands nothing back: leave it unbound and it runs for its effects.

### Pitfalls

- **Reaching for a loop.** "For each attachment…" is a traversal-headed block. If you're trying to enumerate, you're describing an edge to traverse.
- **Counting the wrong thing.** \`count\` over a *source* walk (\`count(msg-[:Attachments]->)\`) counts what the source holds; \`count\` over a bound block (\`count(orgs)\`) counts what the block *returned*. Both run — make sure you aggregate the one you mean.
- **Reaching inside a block from outside it.** A name bound in the body — the head's alias \`a\` included — does not exist after the closing brace. \`return\` what the rest of the automation needs.`,
  engineClaims: [
    {
      construct: 'graph-rooted query traversals (WHERE / ORDER BY / LIMIT on a collection hop)',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

function \`Top Ten\`(go: <runs-[:Invocation]->>) {
  crm-[c:Companies WHERE c.Categories == "Customer" ORDER BY c.\`Created At\` DESC LIMIT 10]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: c.Name
    }
  }
  if (exists(crm-[k:Companies WHERE k.Categories == "Customer" ORDER BY k.Name LIMIT 1]->)) {
    crm-[top:Companies ORDER BY top.Name DESC LIMIT 1]-> {
      write top-[:Notes]-> { Title: "Last by name", Content: top.Name }
    }
  }
}

listen to runs {} fire \`Top Ten\`
`,
    },
    {
      construct: 'an ORDER BY key that walks one hop off the record it ranks',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

function \`By Company\`(go: <runs-[:Invocation]->>) {
  crm-[p:People ORDER BY p-[:Company]->.Name LIMIT 5]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: p.Name
    }
  }
}

listen to runs {} fire \`By Company\`
`,
    },
    {
      construct: 'a walk wrapped in a closure, called only in the branch that needs it',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

function \`Recent\`(go: <runs-[:Invocation]->>) {
  customers = () => crm-[c:Companies WHERE c.Categories == "Customer" ORDER BY c.\`Created At\` DESC LIMIT 5]->
  if (go.Text == "report") {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:        "Report"
      Description: "\${count(customers())} recent customers"
    }
  }
}

listen to runs {} fire \`Recent\`
`,
    },
    {
      construct: 'a block returning a record — the returned handles counted and walked after it',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio, \`@lf/slack\` as slack } from adapters
import { acme, team_workspace } from credentials

inbox = connect email
crm   = connect attio using acme
team  = connect slack using team_workspace

function \`Intake\`(m: <inbox-[:Email]->>) {
  orgs = m-[f:Attachments]-> {
    return write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: f.Name
    }
  }
  orgs-[n:Notes]-> {
    write n { Title: "Logged" }
  }
  general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  write general-[:Messages]-> {
    Message: "Logged \${count(orgs)} companies"
  }
}
`,
    },
    {
      construct: 'the record-order rules — only for a lookup, Text.join over an ordered relationship, LIMIT on a sequenced one',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio, \`@lf/slack\` as slack } from adapters
import { acme, team_workspace } from credentials

inbox = connect email
crm   = connect attio using acme
team  = connect slack using team_workspace

function \`Digest\`(m: <inbox-[:Email]->>) {
  channel = only(team-[ch:Channels WHERE ch.Name == "general"]->)
  if (channel == null) { fail("no #general") }
  files  = Text.join(m-[a:Attachments]->.Name, ", ")
  recent = Text.join(crm-[c:Companies ORDER BY c.\`Created At\` DESC LIMIT 5]->.Name, ", ")
  said   = Text.join(channel-[msg:Messages LIMIT 20]->.Message, "
")
  write channel-[:Messages]-> {
    Message: "\${files} / \${recent} / \${said}"
  }
}
`,
    },
    {
      construct: 'a block returning a value — every iteration collected as a list',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

inbox = connect email
team  = connect slack using team_workspace

function \`Name Them\`(m: <inbox-[:Email]->>) {
  names = m-[f:Attachments]-> {
    if (f.Name == "") {
      return "unnamed"
    }
    return f.Name
  }
  general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  write general-[:Messages]-> {
    Message: "\${count(names)} files: \${Text.join(names, ", ")}"
  }
}
`,
    },
  ],
};
