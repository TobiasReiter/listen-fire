import type { Chapter } from '../types';

export const asks: Chapter = {
  id: 'reviews',
  title: 'Reviews — pausing for a human decision',
  content: `## Reviews — pausing for a human decision

Pause a run for a person's judgement: **write** a question, deliver the link it mints, then **await** the answer. The run stops, the person decides, and the run resumes exactly where it left off with every handle and binding it had — minutes or days later, holding nothing open in the meantime.

Reach for one only when a *judgement* is genuinely needed. A value you can compute, extract, or default with a \`?:\` set-if-empty field is not one.

### how-it-works

\`\`\`
asks = ask()

q = write asks-[:Check]-> { Prompt: "Pursue this company?" }
\`\`\`

- The **family** edge (\`Check\` here) is the kind of question, and it fixes the type of the answer.
- \`q.Url\` is the link a person opens — the only delivery affordance. Nothing is sent for you; you interpolate that \`Url\` into a message yourself.
- \`await FIRST(q-[:Response]->)\` is the only way to read the answer. \`FIRST(…)\` is the ordinary read — nothing answered yet reads as nothing; \`await\` in front of it holds the run until there *is* something to read.

### the-families

Every family takes \`Prompt\` (the question) and an optional \`Detail\` (a longer explanation shown under it), plus the parameters below.

- **Check** — approve or decline. \`Answer\` is a boolean, \`true\` if they approved.
- **Provide** — supply one value. \`Answer Type\` (required) is \`"text"\`, \`"number"\`, \`"date"\`, or \`"boolean"\`; \`Answer\` is that type.
- **Choose** — pick ONE. \`Options\` (required, at least one) is the set; \`Answer\` is the option they chose.
- **Select** — pick a SUBSET. \`Options\` (required) again; \`Answer\` is the list they ticked, possibly empty.
- **Review** — an acknowledgement. Nothing to fill in and nothing extra to supply: the person confirms they have read the \`Detail\`, and \`Answer\` carries no value. Await it and carry on.
- **Form** — collect several named fields at once. \`Fields\` (required) names them; name them literally and each becomes a field of the answer you read like any record's, \`\` a.\`Budget\` \`\`, every one text.

Spell a parameter out as a literal and the answer narrows while you write it: a \`Choose\` over \`["ship", "hold"]\` answers one of exactly those two, and comparing it to anything else is caught then and there; \`Answer Type: "number"\` answers a number. Build the options at run time instead and the answer is plain text — still correct, just unnarrowed. A literal \`Fields\` narrows the same way, into one field per name.

\`\`\`
q = write asks-[:Form]-> {
  Prompt: "Fill in the missing details"
  Fields: ["Company", "Contact", "Budget"]
}

a = await FIRST(q-[:Response]->)
write company-[:Notes]-> {
  Title:   "Intake details"
  Payload: a.\`Budget\`
}
\`\`\`

Build those names at run time and there is nothing to read a field off — the editor warns you on save, and the answer stays \`a.Answer\`, one **structured** value carrying them all. A structured value is opaque. Pass it on into a structured field, but you cannot pick a piece out of it, compare it, or branch on it.

So when you need a value to *act* on — a name to look up, a number to write into a typed field — reach for \`Provide\`, \`Choose\`, \`Select\`, or a \`Form\` whose \`Fields\` you spelled out.

### delivering-and-awaiting

\`\`\`
q = write asks-[:Check]-> { Prompt: "Pursue this company?" }

deals = ONLY(chat-[ch:Channels WHERE \`Name\` == "deals"]->)
if deals == null { ERROR("no #deals channel") }
write deals-[:Messages]-> { Message: "New company — pursue it? \${q.Url}" }

answer = await FIRST(q-[:Response]->)
if answer.Answer {
  write crm-[:Companies]-> { unique by (FUZZY \`Name\`), Name: \`Company Name\` }
}
\`\`\`

- Deliver the \`Url\` wherever the person is — a channel post as here, an email, a text message. Whoever opens it gets the control the family calls for; nothing renders that control into the delivery for you.
- An \`await\` on its own waits indefinitely. For anything unattended, give it a deadline (below).
- When the run was started from a chat interface, an undelivered question is **relayed**: the run pauses, the person is shown the question, and their decision is what answers it — never the assistant's own judgement.

### the-pick-idiom

Letting a person pick a **live record** — one company out of the several you found — needs no special family. Compose it: offer the names, then filter the graph on the answer.

\`\`\`
found = crm-[c:Companies WHERE \`Categories\` == "Lead"]-> {
  return c.\`Name\`
}

q = write asks-[:Choose]-> {
  Prompt: "Which company did they mean?"
  Options: found
}

a = await FIRST(q-[:Response]->)
pick = ONLY(crm-[co:Companies WHERE \`Name\` == a.Answer]->)
if pick == null { ERROR("no company named \${a.Answer}") }
write pick-[:Notes]-> { Title: "Chosen", Content: "Picked from \${COUNT(found)} candidates." }
\`\`\`

Options gathered at run time are ordinary — the answer is plain text rather than one of a known set, which is what it honestly is. The answer names the record; the lookup after it keys on that name.

### timeout-and-escalation

Give an unattended question a deadline by racing the wait for it against a \`sleep\` and proceeding with whichever settles first. There is no \`fallback\` clause — a deadline, a reminder, and an escalation are all **composed** from those two pieces:

\`\`\`
deals = ONLY(chat-[ch:Channels WHERE \`Name\` == "deals"]->)
if deals == null { ERROR("no #deals channel") }

r = await race([
  () => {
    a = await FIRST(q-[:Response]->)
    return a.Answer
  },
  () => {
    await sleep(6h)
    write deals-[:Messages]-> { Message: "Still waiting: \${q.Url}" }
    await sleep(2d)
  },
])

decision = AT(r, 0)
if decision == null {
  write deals-[:Messages]-> { Message: "Nobody decided in time — holding." }
}
if decision == TRUE {
  write crm-[:Companies]-> { unique by (FUZZY \`Name\`), Name: \`Company Name\` }
}
\`\`\`

- \`await\` is what waits, always: it holds the run until the thing in front of it is satisfied, and what comes back has the not-yet dropped from it. \`race\` says only how several things being waited on **combine** — it settles on the first of them. It does not wait for anything on its own, so it is written under an \`await\`.
- Each arm is a **function**: \`() => { … }\` written where it stands, or the name of one declared elsewhere. An arm takes no parameters — it already sees everything in scope where you wrote it — and it starts the moment the combinator does.
- The value is a **receipt**: one slot per arm, in the order written, holding whatever that arm \`return\`ed. \`AT(r, 0)\` reads the first arm's slot, \`AT(r, 1)\` the second. An arm that hands nothing back has an always-null slot.
- Under \`race\`, only the arm that settled first has its slot filled and every other slot is null — so **a null test on a slot is the branch**, as \`decision == null\` is here. Arms still parked when one settles are dropped where they stand: their waiting stops, and whatever they had already done stays done. Arms that settle in the same moment all land.
- To wait for **every** one instead, \`MAP\` over the functions and call each (below): every one runs to the end and every slot is filled.
- Arms run at once. Arms writing the same \`unique by\` key take turns, so the record is made once.
- Durations are bare unit-suffixed literals: \`30s\`, \`90m\`, \`6h\`, \`2d\`, \`1h30m\`.
- To wait on a *condition* instead — "until this record is marked done" — hand \`until\` the condition and the cadence to re-check it on:

  \`\`\`
  await until(() => {
    refresh company
    return company.\`Stage\` == "Won"
  }, every: 1h)
  \`\`\`

  \`(…) => { … }\` is a **closure**: a body written where it stands and run later, holding everything in scope at the point you wrote it. The run resumes the moment the closure returns true. \`refresh\` re-reads a handle so each check sees the record as it is now; a condition that needs no refresh can be a plain boolean expression instead (\`await until(COUNT(q-[:Response]->) >= 3, every: 10m)\`). A condition takes no parameters and may only read — a write or an \`await\` inside one is refused, as is a cadence under a minute.

- Which of the two you write is the relationship's to decide, and you are told when you save. Where the system announces what landed — a question's \`Response\`, a chat thread's \`Replies\`, a callback's \`Called\` — \`await FIRST(…)\` is the form: the run sleeps and is woken the moment it arrives, so there is no cadence to name. Where nothing announces it, \`await FIRST(…)\` is refused and \`until\` with an \`every:\` is the form, because someone has to say how often to look. Polling something that does announce still works, and is flagged: it just waits longer than it needs to.

### several-at-once

Put one decision in front of several places at once by minting **one** callback, delivering it everywhere, then awaiting it once: whoever taps first settles it, wherever they were. A button in a channel people already read is the lightest way to put a decision in front of them, so that is what each channel gets:

\`\`\`
approve = callback({ })

chat-[ch:Channels WHERE \`Topic\` == "approvals"]-> {
  write ch-[:Messages]-> {
    Message: "Approve this?"
    Blocks: [ … ]              # one control carrying "\${approve.id}"
  }
}

r = await race([
  () => {
    tap = await FIRST(approve-[:Called]->)
    return tap.\`At\`
  },
  () => { await sleep(1d) },
])

if AT(r, 0) == null { … }      # nobody tapped inside the day
\`\`\`

One callback in several places settles on the first tap but says nothing about **where** it came from — every place carried the same control, so there is nothing to tell them apart. When that matters, give each place its own callback and its own arm. An arm is written where you already know the place, so it can hand that back along with the answer:

\`\`\`
deals = callback({ })
board = callback({ })

\`Deals Channel\` = ONLY(chat-[ch:Channels WHERE \`Name\` == "deals"]->)
if \`Deals Channel\` == null { ERROR("no #deals channel") }
\`Board Channel\` = ONLY(chat-[b:Channels WHERE \`Name\` == "board"]->)
if \`Board Channel\` == null { ERROR("no #board channel") }

write \`Deals Channel\`-[:Messages]-> { Message: "Approve this?", Blocks: [ … ] }   # carries "\${deals.id}"
write \`Board Channel\`-[:Messages]-> { Message: "Approve this?", Blocks: [ … ] }   # carries "\${board.id}"

r = await race([
  () => {
    tap = await FIRST(deals-[:Called]->)
    return { channel: "deals", at: tap.\`At\` }
  },
  () => {
    tap = await FIRST(board-[:Called]->)
    return { channel: "board", at: tap.\`At\` }
  },
])

first = AT(r, 0)
if first != null {
  general = ONLY(chat-[g:Channels WHERE \`Name\` == "general"]->)
  if general == null { ERROR("no #general channel") }
  write general-[:Messages]-> { Message: "approved in #\${first.channel} at \${first.at}" }
}
\`\`\`

- The slot already says which arm settled — \`AT(r, 0)\` is the first one written. Handing the identity back is for when it has to travel further: into a message, a write field, a comparison later on.
- Return a dict to hand back more than one thing at once; its entries read by name afterwards (\`first.channel\`).

Wait on **different** things at once by giving each its own function, and take every answer rather than the first by mapping over them, calling each at once:

\`\`\`
r = MAP([
  () => {
    b = await FIRST(budget-[:Response]->)
    return b.Answer
  },
  () => {
    l = await FIRST(legal-[:Response]->)
    return l.Answer
  },
], { concurrency: 2 }, (f) => f())

if AT(r, 0) AND AT(r, 1) { … }
\`\`\`

- Which field on a control carries the \`id\` is that system's own business, and its chapter says. Reach for a written question instead when you need what one gives you — a page, and an entry in somebody's queue (see \`when-a-question-and-when-a-callback\`).
- Nothing a MAP runs is dropped, so every slot is filled and none of them needs a null test. There is no \`await\` in front: a function that waits parks the run, and the MAP finishes when every one has.

### in-chat-answers

\`Response\` is an ordinary writable edge, so anything that can write can answer — a button included. Mint a **callback** per answer and give each control the callback's \`id\`; a tap then resolves the question in place, with no page hop.

\`\`\`
q   = write asks-[:Check]-> { Prompt: "Pursue this company?" }
yes = callback({ write q-[:Response]-> { Answer: TRUE } })
no  = callback({ write q-[:Response]-> { Answer: FALSE } })
\`\`\`

The controls carry \`"\${yes.id}"\` and \`"\${no.id}"\` — which field on a control holds it is that system's own business, and its chapter says. Keep \`q.Url\` in the message text as well, so anyone who cannot tap can still respond.

### a-callback-as-a-link

A callback also has a \`url\` — the same block of work reached the other way. The \`id\` is what a control carries; the \`url\` is what you hand out where there are no controls: an email, a text message, a system whose messages are plain prose.

Opening that url does **not** act. It shows a page saying what is about to happen and waits for the person to confirm, so a client that fetches links in the background, or a scanner following every link in a message, can never decide on someone's behalf.

### how-often-a-callback-can-be-used

A callback is used **once** by default: the first person to act settles it, and anyone arriving after is told it is closed. A second argument changes that:

\`\`\`
nudge = callback({ … }, { once: FALSE })
today = callback({ … }, { ttl: 4h })
\`\`\`

\`once: FALSE\` makes it repeatable — every use runs the block again. \`ttl\` stops it working after that long. Both are bounded by the run that minted it, which is the shorter leash: a \`ttl\` longer than the run's own life changes nothing.

### a-value-supplied-when-someone-acts

Some controls have nothing to pre-wire, because what the person supplies does not exist until they act — a date picker, a text box. Write the deferred work as a **closure** — \`(<parameters>) => { … }\`, a body run later that holds everything in scope where you wrote it — and the supplied value arrives bound to the parameter's name:

\`\`\`
booked = callback((day: <date>) => {
  write ch-[:Messages]-> { Message: "Booked for \${day}." }
})
\`\`\`

A parameter is a plain **value** the other side hands back — \`<text>\`, \`<number>\`, \`<boolean>\`, \`<date>\`, \`<datetime>\`, \`<json>\`, \`<file>\`. It can never be a record position: nothing out there can hand back a row from a connected system, so that is refused while you write it. Anything already known when the control goes out is not a parameter — put it in the body, which captures everything in scope.

The same values come back on the \`Called\` landing, one field per parameter, alongside \`At\`.

### deferring-work-by-name

A callback can defer a NAMED block of work instead of an inline one — the one place in the language where a declaration stands as a value:

\`\`\`
function \`Chase\`(c: <crm-[:Companies]->>) {
  write c-[:Notes]-> { Title: "Chased", Content: "Nudged again." }
}

again = callback(\`Chase\`(company), { once: FALSE })
\`\`\`

The arguments are fixed when the control goes out; a parameter left off the end is what the acting side fills in.

### when-a-question-and-when-a-callback

A callback on its own is the lighter thing: \`go = callback()\` with \`await FIRST(go-[:Called]->)\` holds the run until somebody presses a button — no page, no queue entry, nothing to open. Write a question when you need what a question gives you: a page rendering the right control for whoever opens the link, wherever they are, and an entry in that person's queue of things to decide — a task directed at somebody. For a decision already in front of the right people in a channel, a callback is enough.

Either way, what a person can act on lives **only as long as the run waiting for it**. When the run ends the buttons stop working and the link stops accepting, and a late tap is told it is closed. Neither is a standing endpoint: something that must react at any time, forever, is an automation that LISTENS.`,
  engineClaims: [
    {
      construct: 'write an ask along a Check family edge, deliver its Url, and await its Response inside a race arm; the timeout is a null test on the slot',
      status: 'runs',
      probe: `
import { email, slack, attio, ask } from adapters
import { team_workspace, acme_main } from credentials

inbox = email()
team  = slack(credentials: team_workspace)
crm   = attio(credentials: acme_main)
asks  = ask()

function \`Triage Inbound\`(msg: <inbox-[:Email]->>) {
  \`Company Name\` = AI("the company this message is about")

  q = write asks-[:Check]-> {
    Prompt: "Pursue \${\`Company Name\`}?"
    Detail: "\${msg.\`Subject\`}"
  }
  deals = ONLY(team-[ch:Channels WHERE \`Name\` == "deals"]->)
  if deals == null { ERROR("no #deals channel") }
  write deals-[:Messages]-> { Message: "New: \${\`Company Name\`}. Pursue it? \${q.Url}" }

  r = await race([
    () => {
      a = await FIRST(q-[:Response]->)
      return a.Answer
    },
    () => { await sleep(2d) },
  ])

  decision = AT(r, 0)
  if decision == TRUE {
    write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name: \`Company Name\`
    }
  }
  if decision == null {
    write deals-[:Messages]-> { Message: "Nobody decided in time." }
  }
}

listen to inbox { key: "intake" } fire \`Triage Inbound\`
`,
    },
    {
      construct: 'one callback delivered to every channel, its tap raced against a timeout, the tap time read off slot 0',
      status: 'runs',
      probe: `
import { slack, manual } from adapters
import { team_workspace } from credentials

team = slack(credentials: team_workspace)
runs = manual()

function \`First Approval Wins\`(go: <runs-[:Invocation]->>) {
  approve = callback({ })

  team-[ch:Channels WHERE \`Topic\` == "approvals"]-> {
    write ch-[:Messages]-> {
      Message: "Approve this?"
      Blocks: [
        { type: "actions", elements: [
          { type: "button", text: { type: "plain_text", text: "Approve" },
            value: "\${approve.id}" }
        ] }
      ]
    }
  }

  r = await race([
    () => {
      tap = await FIRST(approve-[:Called]->)
      return tap.\`At\`
    },
    () => { await sleep(1d) },
  ])

  tapped = AT(r, 0)
  general = ONLY(team-[g:Channels WHERE \`Name\` == "general"]->)
  if general == null { ERROR("no #general channel") }
  if tapped != null {
    write general-[:Messages]-> { Message: "Approved at \${tapped}." }
  }
  if tapped == null {
    write general-[:Messages]-> { Message: "Nobody approved in time." }
  }
}

listen to runs {} fire \`First Approval Wins\`
`,
    },
    {
      construct: 'a race arm handing back WHICH place answered — a dict built in the arm that knows it',
      status: 'runs',
      probe: `
import { slack, manual } from adapters
import { team_workspace } from credentials

team = slack(credentials: team_workspace)
runs = manual()

function \`Which Place Answered\`(go: <runs-[:Invocation]->>) {
  dealflow = callback({ })
  portfolio = callback({ })

  \`Dealflow Channel\` = ONLY(team-[ch:Channels WHERE \`Name\` == "dealflow"]->)
  if \`Dealflow Channel\` == null { ERROR("no #dealflow channel") }
  \`Portfolio Channel\` = ONLY(team-[p:Channels WHERE \`Name\` == "portfolio"]->)
  if \`Portfolio Channel\` == null { ERROR("no #portfolio channel") }

  write \`Dealflow Channel\`-[:Messages]-> {
    Message: "Approve this?"
    Blocks: [
      { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Approve" },
          value: "\${dealflow.id}" }
      ] }
    ]
  }
  write \`Portfolio Channel\`-[:Messages]-> {
    Message: "Approve this?"
    Blocks: [
      { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "Approve" },
          value: "\${portfolio.id}" }
      ] }
    ]
  }

  r = await race([
    () => {
      tap = await FIRST(dealflow-[:Called]->)
      return { channel: "dealflow", at: tap.\`At\` }
    },
    () => {
      tap = await FIRST(portfolio-[:Called]->)
      return { channel: "portfolio", at: tap.\`At\` }
    },
  ])

  first = AT(r, 0)
  if first != null {
    general = ONLY(team-[g:Channels WHERE \`Name\` == "general"]->)
    if general == null { ERROR("no #general channel") }
    write general-[:Messages]-> {
      Message: "approved in #\${first.channel} at \${first.at}"
    }
  }
}

listen to runs {} fire \`Which Place Answered\`
`,
    },
    {
      construct: 'MAP over two awaiting closures, calling each at once — every slot filled, both answers combined',
      status: 'runs',
      probe: `
import { slack, ask, manual } from adapters
import { team_workspace } from credentials

team = slack(credentials: team_workspace)
asks = ask()
runs = manual()

function \`Both Must Agree\`(go: <runs-[:Invocation]->>) {
  budget = write asks-[:Check]-> { Prompt: "Budget approved?" }
  legal  = write asks-[:Check]-> { Prompt: "Legal approved?" }

  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> {
    Message: "Budget: \${budget.Url}\\nLegal: \${legal.Url}"
  }

  r = MAP([
    () => {
      b = await FIRST(budget-[:Response]->)
      return b.Answer
    },
    () => {
      l = await FIRST(legal-[:Response]->)
      return l.Answer
    },
  ], { concurrency: 2 }, (f) => f())

  if AT(r, 0) AND AT(r, 1) {
    general = ONLY(team-[g:Channels WHERE \`Name\` == "general"]->)
    if general == null { ERROR("no #general channel") }
    write general-[:Messages]-> { Message: "Both approved: \${go.\`Text\`}." }
  }
}

listen to runs {} fire \`Both Must Agree\`
`,
    },
    {
      construct: 'await until — a closure condition refreshing a written handle, on a named cadence',
      status: 'runs',
      probe: `
import { attio, slack, manual } from adapters
import { acme_main, team_workspace } from credentials

crm  = attio(credentials: acme_main)
team = slack(credentials: team_workspace)
runs = manual()

function \`Wait For The Name\`(go: <runs-[:Invocation]->>) {
  co = write crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    Name: go.\`Text\`
  }

  await until(() => {
    refresh co
    return co.\`Name\` == "Acme"
  }, every: 1h)

  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "Renamed at last." }
}

listen to runs {} fire \`Wait For The Name\`
`,
    },
    {
      construct: 'a Provide question with a literal Answer Type, its typed answer filled into a record with ?:',
      status: 'runs',
      probe: `
import { slack, attio, ask, manual } from adapters
import { team_workspace, acme_main } from credentials

team = slack(credentials: team_workspace)
crm  = attio(credentials: acme_main)
asks = ask()
runs = manual()

function \`Record Headcount\`(go: <runs-[:Invocation]->>) {
  q = write asks-[:Provide]-> {
    Prompt: "How many people work there?"
    \`Answer Type\`: "number"
  }
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "How many people work there? \${q.Url}" }

  a = await FIRST(q-[:Response]->)
  write crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    Name:           go.\`Text\`
    Description ?:  "Headcount: \${a.Answer}"
  }
}

listen to runs {} fire \`Record Headcount\`
`,
    },
    {
      construct: 'a Choose question over literal options, its answer compared against one of them',
      status: 'runs',
      probe: `
import { slack, attio, ask, manual } from adapters
import { team_workspace, acme_main } from credentials

team = slack(credentials: team_workspace)
crm  = attio(credentials: acme_main)
asks = ask()
runs = manual()

function \`Decide Next Step\`(go: <runs-[:Invocation]->>) {
  q = write asks-[:Choose]-> {
    Prompt: "What next?"
    Options: ["pursue", "hold", "pass"]
  }
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "What next? \${q.Url}" }

  a = await FIRST(q-[:Response]->)
  if a.Answer == "pursue" {
    write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name: go.\`Text\`
    }
  }
}

listen to runs {} fire \`Decide Next Step\`
`,
    },
    {
      construct: 'a Select question over literal options, its chosen subset joined into a message',
      status: 'runs',
      probe: `
import { slack, ask, manual } from adapters
import { team_workspace } from credentials

team = slack(credentials: team_workspace)
asks = ask()
runs = manual()

function \`Pick Channels\`(go: <runs-[:Invocation]->>) {
  q = write asks-[:Select]-> {
    Prompt: "Which teams should hear about this?"
    Options: ["sales", "support", "finance"]
  }
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "Who should hear about this? \${q.Url}" }

  a = await FIRST(q-[:Response]->)
  write ops-[:Messages]-> { Message ?: "Telling: \${JOIN(a.Answer, ", ")}" }
}

listen to runs {} fire \`Pick Channels\`
`,
    },
    {
      construct: 'a Review question — an acknowledgement awaited before the work carries on',
      status: 'runs',
      probe: `
import { slack, attio, ask, manual } from adapters
import { team_workspace, acme_main } from credentials

team = slack(credentials: team_workspace)
crm  = attio(credentials: acme_main)
asks = ask()
runs = manual()

function \`Acknowledge First\`(go: <runs-[:Invocation]->>) {
  q = write asks-[:Review]-> {
    Prompt: "Read this before it goes out"
    Detail: go.\`Text\`
  }
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "Please read: \${q.Url}" }

  await FIRST(q-[:Response]->)
  write crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    Name: go.\`Text\`
  }
}

listen to runs {} fire \`Acknowledge First\`
`,
    },
    {
      construct: 'a Draft question — a structured artifact composed by a person, awaited',
      status: 'runs',
      probe: `
import { slack, ask, manual } from adapters
import { team_workspace } from credentials

team = slack(credentials: team_workspace)
asks = ask()
runs = manual()

function \`Draft The Reply\`(go: <runs-[:Invocation]->>) {
  q = write asks-[:Draft]-> {
    Prompt: "Draft the reply"
    Detail: go.\`Text\`
  }
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "Draft it here: \${q.Url}" }

  await FIRST(q-[:Response]->)
  write ops-[:Messages]-> { Message: "The draft is in." }
}

listen to runs {} fire \`Draft The Reply\`
`,
    },
    {
      construct: 'a Correct question whose Rows are written as literal objects',
      status: 'runs',
      probe: `
import { slack, ask, manual } from adapters
import { team_workspace } from credentials

team = slack(credentials: team_workspace)
asks = ask()
runs = manual()

function \`Fix The Rows\`(go: <runs-[:Invocation]->>) {
  q = write asks-[:Correct]-> {
    Prompt: "Fix anything that's wrong, drop anything that isn't real"
    Rows: [
      { Name: "Acme", Stage: "New", Owner: go.\`Run by (email)\` },
      { Name: "Initech", Stage: "Open", Owner: go.\`Run by (email)\` }
    ]
  }
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "Check these before they land: \${q.Url}" }

  await FIRST(q-[:Response]->)
  write ops-[:Messages]-> { Message: "Corrections in." }
}

listen to runs {} fire \`Fix The Rows\`
`,
    },
    {
      construct: 'a Form question collecting several named fields at once, one of them read back by name',
      status: 'runs',
      probe: `
import { slack, ask, manual } from adapters
import { team_workspace } from credentials

team = slack(credentials: team_workspace)
asks = ask()
runs = manual()

function \`Collect The Details\`(go: <runs-[:Invocation]->>) {
  q = write asks-[:Form]-> {
    Prompt: "Fill in the missing details"
    Fields: ["Company", "Contact", "Budget"]
  }
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "A few details needed: \${q.Url}" }

  a = await FIRST(q-[:Response]->)
  write ops-[:Messages]-> { Message: "Details in — budget \${a.\`Budget\`}." }
}

listen to runs {} fire \`Collect The Details\`
`,
    },
    {
      construct: 'the pick idiom — Choose over options gathered at run time, the answer filtering the graph back to the record',
      status: 'runs',
      probe: `
import { manual, attio, slack, ask } from adapters
import { acme_main, team_workspace } from credentials

runs = manual()
crm  = attio(credentials: acme_main)
team = slack(credentials: team_workspace)
asks = ask()

function \`Pick The Company\`(go: <runs-[:Invocation]->>) {
  found = crm-[c:Companies WHERE \`Categories\` == "Lead"]-> {
    return c.\`Name\`
  }

  q = write asks-[:Choose]-> {
    Prompt: "Which company did they mean?"
    Options: found
  }
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "Which one? \${q.Url}" }

  a = await FIRST(q-[:Response]->)
  pick = ONLY(crm-[co:Companies WHERE \`Name\` == a.Answer]->)
  if pick == null { ERROR("no company named \${a.Answer}") }
  write pick-[:Notes]-> {
    Title:   "Chosen"
    Content: go.\`Text\`
  }
}

listen to runs {} fire \`Pick The Company\`
`,
    },
    {
      construct: 'callbacks handed out as links (url) answering a question, one repeatable',
      status: 'runs',
      probe: `
import { slack, ask, manual } from adapters
import { team_workspace } from credentials

team = slack(credentials: team_workspace)
asks = ask()
runs = manual()

function \`Decide By Link\`(go: <runs-[:Invocation]->>) {
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }

  q   = write asks-[:Check]-> { Prompt: "Pursue this company?" }
  yes = callback({ write q-[:Response]-> { Answer: TRUE } })
  no  = callback({ write q-[:Response]-> { Answer: FALSE } })
  nudge = callback(
    { write ops-[:Messages]-> { Message: "Still waiting: \${q.Url}" } },
    { once: FALSE, ttl: 2d }
  )

  write ops-[:Messages]-> {
    Message: "Pursue it?\\nYes: \${yes.url}\\nNo: \${no.url}\\nNudge the channel: \${nudge.url}\\nOr decide on the page: \${q.Url}"
  }

  answer = await FIRST(q-[:Response]->)
  if answer.Answer {
    write ops-[:Messages]-> { Message: "Pursuing." }
  }
}

listen to runs {} fire \`Decide By Link\`
`,
    },
    {
      construct: 'a parameterized callback awaited on Called, alongside one deferring a named function',
      status: 'runs',
      probe: `
import { slack, attio, manual } from adapters
import { team_workspace, acme_main } from credentials

team = slack(credentials: team_workspace)
crm  = attio(credentials: acme_main)
runs = manual()

function \`Chase\`(c: <crm-[:Companies]->>) {
  write c-[:Notes]-> {
    Title:   "Chased"
    Content: "Nudged again."
  }
}

function \`Book The Follow Up\`(go: <runs-[:Invocation]->>) {
  company = write crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    Name: go.\`Text\`
  }

  booked = callback((day: <date>) => {
    write company-[:Notes]-> {
      Title:   "Follow-up booked"
      Content: "Booked for \${day}."
    }
  })
  again = callback(\`Chase\`(company), { once: FALSE })

  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> {
    Message: "Pick a day: \${booked.url}\\nOr chase again: \${again.url}"
  }

  call = await FIRST(booked-[:Called]->)
  write ops-[:Messages]-> { Message: "Booked for \${call.\`day\`} (\${call.\`At\`})." }
}

listen to runs {} fire \`Book The Follow Up\`
`,
    },
    {
      construct: 'a named function deferred positionally, its last parameter left for the acting side to fill',
      status: 'runs',
      probe: `
import { slack, attio, manual } from adapters
import { team_workspace, acme_main } from credentials

team = slack(credentials: team_workspace)
crm  = attio(credentials: acme_main)
runs = manual()

function \`Book\`(c: <crm-[:Companies]->>, day: <date>) {
  write c-[:Notes]-> { Title: "Booked", Content: "Booked for \${day}." }
}

function \`Offer\`(go: <runs-[:Invocation]->>) {
  company = write crm-[:Companies]-> { unique by (FUZZY \`Name\`), Name: go.\`Text\` }
  pick = callback(\`Book\`(company))
  ops = ONLY(team-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "Pick a day: \${pick.url}" }
}
`,
    },
  ],
};
