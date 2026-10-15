import type { Chapter } from '../types';

export const expressions: Chapter = {
  id: 'expressions',
  title: 'Expressions — reading, combining, and generating values',
  content: `## Expressions — reading, combining, and generating values

Everywhere an automation needs a value — a write field, an \`if\` condition, an item in an extraction's data list — it uses the same expression grammar. To choose between two values inside one, use \`IF <cond> THEN <a> ELSE <b> END\`; the lowercase statement \`if\` branches whole statements instead, and has its own chapter.

### interpolation

\`\`\`
Message: "New enquiry from \${msg-[:Sender]->.\`Name\`}:
  \${company.url}"
\`\`\`

Double-quoted strings span newlines and interpolate with \`\${…}\`. A value that may not be there prints as nothing, so \`"\${x}"\` needs no fallback — in an \`AI("…")\` prompt too. Whenever you are composing prose a person will read, write it as a template rather than as a \`CONCAT\` — the template shows the paragraphs it produces.

### ai

\`\`\`
Name: AI("the company name this email is about.
  Prefer the legal entity name over the brand name;
  ignore the sender's own firm.

  The email:
  Subject: \${msg.\`Subject\`}
  \${msg.\`Body\`}")
\`\`\`

\`AI("…")\` computes one value from an instruction in plain prose. **The model sees only your prompt** — not the triggering event, not the message body, nothing else from the run — so interpolate in the content the judgement needs. A prompt with no interpolated content is answered blind, and that is the usual cause of an \`AI()\` value that comes back empty or generic. For several records with several fields each, declare an \`extract\` tree instead: one pass rather than many independent calls.

A second argument says how much thinking the answer is worth. Three tiers, and nothing else to choose:

- \`"quick"\` — fast and cheap. Right for reformatting, tidying and classification: work where the answer is already in the prompt and only has to be picked out or restated.
- \`"careful"\` — a solid general answer. Right when the judgement is real but not hard.
- \`"thorough"\` — slow and expensive, and it genuinely reasons. Worth it for ranking, weighing trade-offs, or working something out over a long input; wasted on anything else.

Leave it off and you get \`"quick"\`. Nothing here names a model: which one answers, and how long it may take over the answer, is ours to keep current, and it changes without your automation changing.

\`\`\`
Category: AI("one of: bug, feature, question — for: \${msg.\`Subject\`}")
Summary:  AI(\`Digest Prompt\`, "careful")
Ranking:  AI("rank these by how well each fits the thesis: \${\`Candidates\`}", "thorough")
\`\`\`

Long prompts read best bound once at file scope under a name of their own, then passed by that name where the call needs them.

\`AI()\` may decide **nothing applies**, and then resolves to a real null rather than placeholder text like "none" or "N/A". Write the prompt so that no answer is a legitimate outcome ("only if…", "if any"), and gate on the result:

\`\`\`
\`Suggested Action\` = AI("a brief, actionable next step — only if one is
  genuinely needed — suggested by this email: \${msg.bodyText}")
if EXISTS(\`Suggested Action\`) {
  channel = ONLY(team-[ch:Channels WHERE \`Name\` == "follow-ups"]->)
  if channel == null { ERROR("no #follow-ups channel") }
  write channel-[:Messages]-> { Message: \`Suggested Action\` }
}
\`\`\`

### meta-fields

\`\`\`
write crm-[:Companies]-> {
  Name:          msg.\`Subject\`
  Description ?: "Owner: \${@user_email} — forwarded in by \${@actor_name} on \${@current_date}"
}
\`\`\`

Values that come from the run itself rather than from any record wear an \`@\` prefix and read like any other value, anywhere an expression can appear. There are eight, in three groups:

- \`@current_date\` (\`"2026-03-12"\`) and \`@current_timestamp\`, the moment the run fires, in UTC — \`Deadline: DATE.ADD_DAYS(@current_date, 14)\`. Every clock reading in a run gives that same moment, however long the run takes. For the date somewhere in particular, reach for \`DATE.TODAY(zone)\`.
- \`@user_email\`, \`@user_name\`, \`@user_id\` — the workspace member the run acts *on behalf of*. Forwarders are followed back to the real person: a message forwarded in by a teammate still names the original sender, the person whose work this is.
- \`@actor_email\`, \`@actor_name\`, \`@actor_id\` — whoever literally triggered the event in the source system, exactly as it reported them, member or not.

The two agree until a forward, relay, or service account sits between the originator and the responsible person. A meta-field the run can't resolve — an event that maps to no workspace member, a source that reports no sender — is simply empty, never an error.

### aggregates

\`\`\`
n       = COUNT(co-[t:Team]->)
owner   = ONLY(co-[t:Team WHERE \`Role\` == "Owner"]->)
newest  = FIRST(crm-[c:Companies ORDER BY \`Created At\` DESC]->.\`Name\`)
thread  = JOIN(ch-[m:Messages LIMIT 20]->.\`Text\`, "
")
roster  = JOIN(SORT(co-[t:Team]->.\`Name\`), ", ")
\`\`\`

An aggregate reads a whole traversal (or a bound block's list) and answers one value. Which ones you may reach for depends on whether what you are reading has an order.

- \`COUNT\`, \`SUM\`, \`AVG\`, \`MIN\`, \`MAX\`, \`COLLECT\` answer the same whatever order the records come in, so they read anything.
- \`ONLY(…)\` is *the one that matched*: it answers that record or value, and fails the run if there turns out to be more than one. Reach for it whenever a \`WHERE\` narrows to a single thing.
- \`JOIN\`, \`FIRST\` and \`LAST\` read a sequence, so they need one — an \`ORDER BY\` on the hop, or a relationship the source keeps in order (a channel's messages, an email's attachments). Without either they are refused while you write. The traversal chapter's *record-order* has the full rules.
- \`JOIN(list, ", ")\` takes the separator as its second argument; over a bound block it joins what the iterations returned.
- \`SORT(list)\` answers the same members in order, so a \`JOIN\`, \`FIRST\`, \`LAST\` or \`AT\` over it reads a sequence. Plain values sort by themselves — \`SORT(scores)\`, \`SORT(scores, DESC)\`. Anything with fields takes a key: \`SORT(rows, \`score\`, DESC)\` ranks each member by that field, and the key may be a short path off the member. The direction is last, and \`ASC\` is the default.

### keyed-values

\`\`\`
sections = { intro: "Welcome", body: "The details", sign_off: "the team" }
line     = AT(sections, "body")
\`\`\`

A **dict** is a set of values looked up by name — write it in braces, read it with \`AT(dict, "key")\`. Keys are text and nothing else: a key of some other kind is refused when you save, with the coercion for you to write (\`DATE.FORMAT(d, "YYYY-MM-DD")\` for a day, or a template for anything else) — there is no one right spelling, and a silent choice is how two halves of the same automation come to disagree about the same day.

A dict written in braces knows its keys, each with its own type. Looked up by a key written in quotes — or read with a dot, \`sections.body\`, which is the same lookup — it answers that key's value, always there; a key it was not written with is refused when you save, naming the closest one. Looked up by a key worked out while the automation runs, it answers \`T | absent\`: a key that is not there is the everyday case, not a failure, so discharge it the way you discharge any other possibly-missing value. A dict whose keys came from data — \`GROUPBY\`'s answer — is always looked up that way.

### iterating-values

\`\`\`
lines    = ch-[m:Messages]-> { return m.\`Text\` }
bulleted = MAP(lines, (t) => "• \${t}")
kept     = FILTER(lines, (t) => LENGTH(t) > 0)
total    = REDUCE(lines, 0, (carried, t) => carried + LENGTH(t))
\`\`\`

Iterate a collection with these five, each given a function that runs once per member. A record is a value too, so a hop written on its own — \`ch-[m:Messages]->\` — is a collection of records, and these read it like any other.

- \`MAP(list, f)\` answers what \`f\` returned, member by member. \`FILTER(list, f)\` keeps the members \`f\` answered \`TRUE\` for. Both hand back a list in the order they were given one.
- \`REDUCE(list, <start>, f)\` carries a value forward — \`f\` is given what it has so far and the next member. It reads the members one after another, so it needs a list with an order, exactly as \`JOIN\` does.
- \`GROUPBY(list, key)\` files each member under the key its function answers, and hands back a dict of **lists**. \`KEYBY(list, key)\` does the same where each key names one member, and hands back a dict of members — a repeated key fails the run, naming it.
- \`rows = MAP(ch-[m:Messages]->, (t) => t)\` hands the records back as records, so a block head walks the answer: \`rows-[a:Author]-> { … }\`. Return a map instead — \`{ who: t }\` — and the answer is a list of maps, one key of each holding a record.
- A map written in braces keeps its keys through all five, so \`AT(r, "who")\` in a later function reads the key's own type, and a misspelt key is caught when you save.
- Read a record's fields with \`.\`, walk it with a block, and test whether two are the same one with \`==\` — a record reached two ways is one record. Putting a record into a field or into text is refused where you write it: write a field off it, or connect the two records with a link.

A function written in place takes its parameter's type from the collection, so there is nothing to annotate, and its body may be a single expression (see *closures*). It may \`await\`: a member that waits parks on its own while the others go on — a waiting member holds its place, so no more than \`concurrency\` members are in flight — and the op hands back its value, in member order, once every member has finished. \`FILTER\` and \`REDUCE\` must \`return\` something — a filter needs a boolean, a reduce needs the value it is carrying. \`MAP\` alone allows a function with no \`return\`: each slot is then absent, and the writes inside it still run — \`MAP(ch-[m:Messages]->, (m) => { write graph-[:note]-> { text: m.\`Text\` } })\` is legal on its own, with no binding, run purely for what it writes.

\`\`\`
theses = MEMBERS(<Thesis>)
\`\`\`

\`MEMBERS(<T>)\` lists a closed type's values in the order they were **declared** — a refinement you wrote, or a field's option set borrowed from a system. That order is a fact about the type, so a report's sections come from the declaration instead of a list kept beside it. A field whose values are merely *known* (other values are legal there too) has no complete membership, and is refused.

### map-and-filter-settings

\`MAP\` and \`FILTER\` take a settings record between the collection and the function, following the convention \`name(data, config record, lambda)\`:

\`\`\`
profiles = MAP(companies, { onError: 'warn', concurrency: 4, initialConcurrency: 1 }, (c) => {
  return extractOne([...content, TEXT.SERIALISE(c, 'JSON')], Profile, { tier: 'careful' })
})
\`\`\`

- \`onError\` says what a member whose function fails does: \`'error'\` (the default) fails the run, \`'warn'\` leaves the member out of the answer and puts a warning naming it and the failure on the run's trace, and \`'ignore'\` leaves it out silently. A \`FILTER\` member whose predicate fails is not kept. Only the member's own failure is forgiven; a cancelled run ends as it always does.
- \`concurrency\` runs that many members at once.
- \`initialConcurrency\` runs a first batch of that size to the end before the rest start. When every member's model call opens with the same content, the first batch warms the provider's prompt cache and the rest read it cheaply.
- The answer is in input order whatever order members finish in, and so is the trace.
- Writes inside members run at once unless they contend for the same record. Two members writing the same \`unique by\` key (or the target's own unique field) take turns, so the record is made once; writes to different keys run together. A \`FUZZY\` key has no exact value to take turns on, so fuzzy writes to one record type take turns with every identity write to that type.
- Each setting is written down, not computed. An unknown key, an \`onError\` outside its three words, a \`concurrency\` below 1 or not whole, and a first batch wider than the rest are refused when you save.
- \`REDUCE\`, \`GROUPBY\` and \`KEYBY\` take no settings. Without a settings record \`MAP\` and \`FILTER\` behave as before.

### closures

A function written in place is a value. Its body is a block, or a single expression as in TypeScript:

\`\`\`
inc     = (v: <number>) => v + 1
shout   = (t: <text>) => UPPER(t)
doubled = MAP(counts, (x) => x * 2)
\`\`\`

- \`(v) => v * 2\` means \`(v) => { return v * 2 }\`.
- Bind a closure to a name and **call it like any function**: \`inc(2)\`, \`double(inc(x)) + 1\`, or \`note(m.Subject)\` on its own line. Its parameters check the arguments, and the call is typed by what the body returns.
- Calling it does what its body does: a model call or a write in the body counts towards the function that calls it. Binding it does nothing.
- The name is a function's name, so it is case-insensitive (\`INC(2)\`) and cannot be a built-in's name (\`upper = (t) => t\` is refused) or another function's in a different case. A name holding a plain value is still not callable.
- A closure that may wait is called on its own line, as a function that waits is, and can be an argument of \`race(f, g)\` or \`all(f, g)\`.
- **A closure is a value, but not data.** It lives in a variable (\`g = made\` then \`g()\`, a closure a function returns) or a parameter, or is passed as an argument to a parameter that takes one (\`MAP(xs, (x) => …)\`, \`all(f, g)\`). It is never kept in a list, under a key of a record or map, or in a field: a dot always reads a field. It is never an operand either: \`IF\`, \`COALESCE\`, a comparison or interpolation does not take one. The call is typed by what the closure returns, so a record it returns is refused where data goes. Something that may not be a closure is not called.
- **A closure's type is written \`<(params) => <return>>\`**, as TypeScript's function type: \`handler: <(c: <Company>) => <text>>\` takes a closure and calls it, so a closure can be handed to a function: \`go(label)\`. A closure fits when it takes what the type hands it and returns what the type returns; one written in place, \`go((c) => c.name)\`, has its parameters typed by the type.
- A closure is also what \`MAP\`, \`FILTER\` and the rest take: pass it inline or by name (\`MAP(xs, inc)\`).

### calls-inside-expressions

Because a function's arguments are ordinary expressions, a call can sit inside any expression: \`double(n) + 1\`, \`extractOne(content, Company)\`, \`COUNT(MAP(xs, f))\`, \`MAP(MAP(xs, f), g)\`, \`log(MAP(xs, f))\`.

- A nested call means exactly what binding it to a name first and reading the name means, and it is checked and typed that way. A call that returns text written into a number field is refused. Its effects count towards the function around it.
- A field reads off any call's result, as it reads off a name: \`extractOne(content, Company).name\`, \`FIRST(people).Name\`, \`lookup(id).email\`. A call whose result may be absent gives a field that may be absent too.
- **Order is left to right, as the text reads.** Every operand before a nested call is read before the call runs, and a call's arguments are all evaluated before its body runs, so \`CONCAT(mark("a"), mark("b"))\` writes \`a\` and then \`b\`.
- **\`IF\`, \`AND\`, \`OR\` and \`COALESCE\` short-circuit**, as TypeScript's \`?:\`, \`&&\`, \`||\` and \`??\` do. An operand they do not need is never evaluated, so a call in an arm that is not taken never runs and its writes never happen. \`COALESCE(x, ONLY(list))\` no longer fails when \`x\` is present, however many values \`list\` holds.
- **Suspension is for statements only.** A call that may wait (a function that \`await\`s) is refused inside an expression, because a wait parks the run where it is written and a place inside an expression has nowhere to come back to. Call it on its own line and use the name.
- **A walk's \`WHERE\`, \`ORDER BY\` and settings are read once per landing**, so a function call, \`MAP\`, \`FILTER\`, \`REDUCE\`, \`GROUPBY\`, \`KEYBY\` or \`MEMBERS\` inside one is refused, naming the binding to write instead. The same goes for the key of \`SORT\`, which is read per member: work the key out per member first with \`MAP\`, then sort by it. A built-in that only computes a value (\`SORT(people, LENGTH(Name))\`) is fine there.

### lists-spread-and-tuples

\`\`\`
pdfs    = m-[a:Attachments WHERE a.\`Content Type\` == "application/pdf"]->.\`File\`
content = [m.\`Body\`, ...pdfs, "end"]
inline  = [m.\`Body\`, ...m-[a:Attachments]->.\`File\`]
\`\`\`

- \`...list\` splices a list into the literal, at the start, the middle or the end, as TypeScript's spread does.
- A walk read for a field spreads too: it splices one value per record the walk landed on, and nothing when there are none. A field that itself holds a list spreads its members.
- Spreading something that is not a list (text, a number, a record, a dict) is refused, and so is spreading a list that may be absent. A \`<json>\` field is refused too, since one landing's list cannot be told apart from several landings.
- **A list literal is a tuple**, one slot per member, as in TypeScript: \`[m.Subject, file]\` is a text then a file. \`AT(t, 0)\` reads the first slot exactly, always present. With a spread the tuple is open-ended: \`[text, ...files]\`.
- **Where a list is expected** (\`MAP\`, \`FILTER\`, \`JOIN\`, a list-typed field or parameter) a tuple reads as a list of the union of its members, as TypeScript reads \`[string, number]\` as \`(string | number)[]\`. \`JOIN([name, amount], " ")\` validates, and \`[name, amount]\` written into a list of numbers is refused.
- A literal holding both records and plain values (\`[company, "label"]\`) is accepted as a tuple, but it is refused wherever it is read as a list, such as \`MAP(both, …)\` or a write into a list field.
- **Unions follow the same way.** \`race(…)\` with arms whose results differ reads as a list of the union of those results, so each slot carries the type of any arm, and may still be absent. \`all(f, g)\` keeps each slot's own type: \`AT(r, 1)\` is what the second returned.

### a-table-you-declare-once

\`\`\`
roster = [
  { Name: "Ada",   Theme: "Consumer" },
  { Name: "Grace", Theme: "Infra" },
  { Name: "Alan",  Theme: "Health" },
]

themes = JOIN(MAP(roster, (r) => "\${r.Name} (\${r.Theme})"), ", ")

node Mention: "each company named, weighed against the team's own themes: \${themes}" {
  name: <text> "the company's name"
}

function \`Match Mentions\`(m: <inbox-[:Email]->>) {
  byName = KEYBY(roster, (r) => r.Name)
  found  = extract([m.\`Body\`], Mention)

  owner = AT(byName, "Ada")
  if owner == null { ERROR("no such teammate on the roster") }
  MAP(found, (c) => {
    write crm-[:Companies]-> { unique by (FUZZY \`Name\`), Name: c.name, Description ?: "flagged by \${owner.Name}" }
  })
}
\`\`\`

A file-scope list of dicts is a small table every function in the file reads. \`MAP\` and \`JOIN\` turn it into one string for a prompt — here, an extraction's description. \`KEYBY\` turns it into a dict keyed by one field, so a lookup is a plain read; a computed key still needs the guard, since \`KEYBY\`'s keys are data.

### spreading-maps-and-records

\`\`\`
base   = { stage: "Seed", source: "email" }
row    = { ...base, stage: "Series A" }
merged = { ...c, ...details }
\`\`\`

- \`...m\` copies a dict's keys into the literal, and \`...r\` copies a record's fields (its values, not its nested nodes), as TypeScript's object spread does. A later key wins over an earlier one, in the order written: \`row.stage\` is \`"Series A"\`.
- A key written before a spread that always has it is refused when you save, since the spread overwrites it. Move it after the spread to override.
- A spread of something that may not be there copies nothing when it isn't, so its keys may be absent: with \`details = extractOne(…)\`, \`merged.summary\` is \`text | absent\`. \`COALESCE\` it before a field that needs a value.
- A graph literal orders its members the same way: \`graph<Note> { ...v, text: "mine" }\` keeps \`"mine"\`, and \`graph<Note> { text: "mine", ...v }\` is refused when \`v\` always has \`text\`.
- The result is a dict. Read it with a dot or with \`AT\`; a misspelt key is caught when you save.
- A record read live from a system has no field list in hand, so spreading one into a dict is refused: build the dict from the fields you want. To walk the result, write into it, or check it against a declaration, build a graph instead — \`graph<Detailed> { ...c, ...details }\` copies the record's fields as a snapshot, the declaration deciding which (see *the extraction call* in the extraction chapter).
- A spread of text, a number or a list is refused. A settings record (\`MAP\`'s, \`extract\`'s, a built-in's options) is written out key by key, so a spread is refused there.

### values-that-may-not-be-there

\`\`\`
Name: COALESCE(msg-[:Sender]->.\`Name\`, msg-[:Sender]->.\`Email\`)
\`\`\`

A traversal that yields nothing makes the value empty rather than failing, and \`COALESCE\` takes the first non-empty of its arguments. To test rather than fall back: \`EXISTS(…)\` tests whether a relationship, a binding, or a field read off one has anything in it — \`EXISTS(msg-[:Sender]->)\`, \`EXISTS(\`Suggested Action\`)\`, \`EXISTS(channel.\`Topic\`)\` — while \`ISNULL(x)\` is the same test inverted.

A separate and stronger thing is a value typed as *possibly not there at all* — \`T | absent\`. That is a real part of the type, not a caution. Five things produce one:

- **an aggregate that can come up empty.** \`ONLY\`, \`FIRST\`, \`LAST\`, \`MIN\`, \`MAX\`, and \`AT\` all answer null when there's nothing to aggregate over, so \`ONLY(msg-[:Attachments]->.\`Name\`)\` may be absent exactly when there are no attachments. Over a *bare* traversal (no field on the end) they bind the whole record, not one of its fields — \`channel = ONLY(chat-[ch:Channels WHERE …]->)\` — see *looking-up-existing-records* in the writes chapter for that idiom;
- **a named \`match\`.** \`existing = match crm-[:Companies]-> { … }\` is the record or absent; test \`existing == null\` (the \`else\` arm sees it present) or \`!= null\` before reading a field off it or linking it;
- **a landing that can resolve empty** — awaiting an answer that was cancelled rather than given yields nothing to read;
- **a \`race\` slot** — \`AT(r, 0)\` reads what the first arm of a \`race\` returned, and only the arm that settled first has its slot filled, so every slot off a \`race\` may be absent. (A \`MAP\` over a list of functions runs every one, so its slots are not.)
- **a field read off a record that may not be there.** \`details = extractOne(…)\` may have found nothing, so \`details.summary\` is \`text | absent\`, as TypeScript types \`details?.summary\`. Test \`details != null\` first, or \`COALESCE\` the field. A graph literal's required field refuses such a value too: declare the field \`<text | null>\`, or fall back.
- **a typed extracted field, and a lookup by a computed key.** A \`<number>\`, \`<date>\`, \`<boolean>\` or set-of-values field of an \`extract\` is something the model was asked for and may not have found, so reading one is \`T | absent\` — a write field takes it with the \`?:\` fill rather than plainly. A text field is never absent: one the model did not find reads as \`""\`, so test it with \`!= ""\` — a null test on it is refused. Annotate it \`<text | null>\` to have a missing one arrive null instead: it is then \`text | absent\` like the rest, and a null test narrows it. \`AT(dict, key)\` with a key worked out at run time is the same: a key that is not there reads nothing.

Reading such a value is always fine, and so is interpolating it — it prints as nothing. Testing it needs no guard either. \`==\` and \`!=\` take it on either side: a missing value equals only \`null\`, so \`o.stage == "Seed"\` is false and \`o.stage != "Seed"\` true when the model found nothing. A condition takes a \`<boolean>\` that may be missing and reads a missing one as false — \`if o.viable { … }\`, \`IF o.viable THEN … ELSE … END\`, \`a AND o.viable\`, \`NOT o.viable\`.

What is refused is **using** it somewhere a value is genuinely required — a write field, a write or traversal target, a field read off it, an ordered comparison (\`<\`, \`<=\`, \`>\`, \`>=\`) — and the refusal comes while you write rather than at run time. There is no "it will probably be there".

Five things discharge it, and one of them always fits:

- **Fill it with \`?:\`.** A set-if-empty write field takes a possibly-missing value happily: present, it lands; missing, that one field simply isn't written and the rest of the write goes ahead.

  \`\`\`
  Description ?: "Headcount: \${a.Answer}"
  \`\`\`

- **Gate on it with a traversal.** A block headed by the landing runs only when the landing is there, and everything inside it knows so: \`q-[a:Response]-> { … }\`.
- **Test it with \`==\`.** Comparing against \`null\` (\`x == null\` / \`x != null\`) is the dedicated presence test, and the one place \`==\` is deliberately loose: \`null\` and absent mean the same thing here, so it's legal against *any* possibly-missing value. Comparing against a present value works too and narrows the same way (\`if a.Answer == "pursue" { … }\` is legal even though \`a.Answer\` may be absent). Either way, the arm that took the comparison knows the value is present — and for \`== null\` used as a guard clause (\`if x == null { ERROR("…") }\`), so does everything **after** the \`if\`, not just the arm. See *narrowing-past-a-guard* in the branching chapter.
- **Fall back with \`COALESCE\`.** \`COALESCE(a, b)\` answers the first of its arguments that has a value, so the moment one of them always does — a literal, or anything already known to be there — the result always does too: \`Name: COALESCE(ONLY(msg-[:Attachments]->.\`Name\`), "no attachment")\`. A \`COALESCE\` whose arguments might *all* be empty is itself possibly-empty and is refused in the same places, so the one-argument form discharges nothing at all.
- **Test it with \`EXISTS\` or \`ISNULL\`.** \`if EXISTS(x) { … }\` narrows \`x\` present *inside that arm only*; the value-level form \`IF EXISTS(x) THEN … ELSE … END\` narrows it present in the \`THEN\` branch only. \`ISNULL\` is that test inverted, which is what a guard clause wants: \`if ISNULL(x) { ERROR("…") }\` proves \`x\` present for everything after the \`if\`. Either takes a bound name or a field read off one — \`if EXISTS(channel.\`Topic\`) { … }\` needs no intermediate binding, and since a field is missing only because its record is, proving the field proves the record with it, so that arm may write off \`channel\` too.

Ordered comparisons get no licence from the \`?:\` fill — there is no write field to fill — so either give the value a fallback with \`COALESCE\`, or prove presence first (a guard clause, an \`EXISTS\`, a traversal gate) and order *inside* the branch — or, for a guard clause, the code after it — that proved it.

### helper-families

Dotted helper families — \`FAMILY.FUNCTION(…)\` — do the messy real-world conversions deterministically: no model involved, the same input always gives the same answer, and an input the helper can't read gives an empty value rather than an error. \`CURRENCY.\` reads money figures out of text (\`"£1.2m"\` → \`1200000\`, or its code → \`"GBP"\`); \`TEXT.\` does surgical string work (a regex extraction, a slug); \`URL.HOST(text)\` reads the host out of a link (\`www.\` kept, no port, no path) and gives empty for text that isn't a URL — the same shape as \`DATE.PARSE\`, one function reading a shape out of loose text; \`DATE.\` handles dates without guesswork — \`DATE.PARSE("12 March 2026")\` → \`"2026-03-12"\`, while an ambiguous numeric form (\`"12/03/2026"\` — day-first or month-first?) deliberately gives empty rather than a guess. \`DATE.FORMAT(value, "MMMM D, YYYY")\` writes a date out for a person to read — \`"August 31, 2026"\` — from the tokens \`YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm m ss s\`, with anything that is not a letter printed as written; the pattern is written down and checked when you save, so an unknown token is named there rather than printed wrong. \`DATE.TODAY(zone)\` and \`DATETIME.AT(date, time, zone)\` do time zones — the next section. The reference chapter lists every family member; a name that isn't one is refused when you save, with the family's real functions listed.

### time-zones-and-windows

Take the day in a place, move whole days on it, and anchor each end of the window on its own:

\`\`\`
berlin_today = DATE.TODAY("Europe/Berlin")
win_end      = DATETIME.AT(berlin_today, "07:00", "Europe/Berlin")
win_start    = DATETIME.AT(DATE.ADD_DAYS(berlin_today, -1), "07:00", "Europe/Berlin")
\`\`\`

**Arithmetic happens in calendar space; anchoring happens last.** \`DATE.ADD_DAYS\` moves a day on the calendar, and \`DATETIME.AT(date, time, zone)\` turns a day plus a wall-clock time into the one instant it names there. Anchor each end separately and the window between yesterday 07:00 and today 07:00 comes out 23 or 25 hours long on the two days a year the clocks move, without you writing anything down. Anchor one end and subtract 24 hours instead, and those two days silently run from 06:00 or 08:00.

\`DATE.TODAY(zone)\` reads the moment the run fired, in that zone — a run firing at 00:30 in Berlin is on the Berlin date, not yesterday's UTC one. Every reading of the clock in one run gives the same answer, including after the run waits for a person, so a window computed at the start and one computed at the end agree.

Both the zone (\`"Europe/Berlin"\`, \`"America/New_York"\`, \`"UTC"\`) and the time (\`"07:00"\`, 24-hour \`HH:mm\`) are written down and checked when you save. \`DATETIME.AT\` always names an instant: on the spring-forward morning a time the clock skips resolves forward to the moment the clock resumed, and on the fall-back morning a time that happens twice takes the first of the two.

### coercers

\`DATE\` and \`DATETIME\` are each two things by the same name, and the dot tells them apart: \`DATE.PARSE(…)\` and \`DATETIME.AT(…)\` are helper families, while the bare \`DATE(value)\` and \`DATETIME(value)\` are **coercers** — they, and \`NUMBER(value)\`, say "treat this as a calendar day / an instant / a number". Reach for a coercer when a comparison spans two kinds of value: a comparison only makes sense within one kind, so \`\`Snoozed Until\` <= 5\` is refused when you save and \`\`Snoozed Until\` <= DATE(…)\` is the repair. (Dates and timestamps compare freely — a date is midnight. When a value's type isn't known, the comparison is left alone; only a definite clash is flagged.)

Prefer a helper over \`AI()\` whenever one fits: it is instant, free, and gives the same answer every run.

Beyond the built-ins, a target system may supply functions of its own on particular fields — a chat system's message formatter on a message's text, say. Those run **as the value of the write field that advertises them**: the target supplies the function, so it exists exactly where you write to that target. Calling one anywhere else — a condition, a plain binding — or calling a name no field advertises, fails the run naming the function.

### file-artifacts

\`\`\`
File: FILE(digest, "pdf")
\`\`\`

\`FILE(content, type)\` turns a composed string into a **file** you can write into a file-typed field — an attachment, a document slot. \`type\` is a literal \`"pdf"\` or \`"text"\`, and the content is rendered as plain text preserving your line breaks, so compose it first (interpolation, or \`JOIN\` over a block's results — the patterns chapter has the digest shape) and then wrap it. The artifact remembers where its content came from: its provenance trail carries the reads that fed the string.

Read a file the other way — \`READ(file)\` hands back the text in it, and \`CHUNKS\` cuts a long text into pieces:

\`\`\`
text   = READ(f.\`File\`)
pieces = CHUNKS(COALESCE(text, ""), { size: 40000, overlap: 2000 })
\`\`\`

- \`READ\` answers \`text | absent\`, discharged like any other absence — \`COALESCE\`, a \`?:\` write field, an \`== null\` guard. Why a file gave nothing back is on the run's own record.
- An extraction reads a file in its content itself. Reach for \`READ\` where you want the text in hand — to cut it, measure it, or pass it to a plugin.
- \`CHUNKS(text, { size, overlap })\` hands back a list of text pieces, each at most \`size\` characters and repeating \`overlap\` characters of the one before it. \`unit:\` takes \`"chars"\` and nothing else.
- Say \`entities\` instead of \`size\` to cut by what a piece is expected to yield — \`CHUNKS(text, { entities: 20 })\` fills each piece with about twenty records' worth of lines, and never splits a line. One of the two is required, and \`overlap\` works with either.
- \`extract(pieces, Shape)\` is one extraction reading every piece; \`MAP(pieces, (p) => extract([p], Shape))\` is one per piece (extraction, *long-documents*).`,
  engineClaims: [
    {
      construct: 'a file-scope table of dict-literal rows, MAP+JOIN into an extraction description, KEYBY+AT as a lookup',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

roster = [
  { Name: "Ada",   Theme: "Consumer" },
  { Name: "Grace", Theme: "Infra" },
  { Name: "Alan",  Theme: "Health" },
]

themes = JOIN(MAP(roster, (r) => "\${r.Name} (\${r.Theme})"), ", ")

node Mention: "each company named, weighed against the team's own themes: \${themes}" {
  name: <text> "the company's name"
}

function \`Match Mentions\`(m: <inbox-[:Email]->>) {
  byName = KEYBY(roster, (r) => r.Name)
  found  = extract([m.\`Body\`], Mention)

  owner = AT(byName, "Ada")
  if owner == null { ERROR("no such teammate on the roster") }
  MAP(found, (c) => {
    write crm-[:Companies]-> { unique by (FUZZY \`Name\`), Name: c.name, Description ?: "flagged by \${owner.Name}" }
  })
}
`,
    },
    {
      construct: 'SORT over a collection in hand, then an order-sensitive fold',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Roster\`(go: <runs-[:Invocation]->>) {
  names  = crm-[p:People]-> { return p.\`Name\` }
  titles = crm-[p:People]-> { return { name: p.\`Name\`, title: p.\`Job Title\` } }
  ranked = SORT(titles, \`title\`, DESC)
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: COALESCE(FIRST(SORT(names)), "nobody")
    Description: "\${COUNT(ranked)} people, \${JOIN(SORT(names, DESC), ", ")}"
  }
}

listen to runs {} fire \`Roster\`
`,
    },
    {
      construct: 'AI() null returns gated with EXISTS() on the binding',
      status: 'runs',
      probe: `
import { email, slack } from adapters
import { acme_slack } from credentials

inbox = email()
team  = slack(credentials: acme_slack)

function \`Follow Up\`(m: <inbox-[:Email]->>) {
  \`Suggested Action\` = AI("a brief, actionable next step — only if one is genuinely needed")
  if EXISTS(\`Suggested Action\`) {
    channel = ONLY(team-[ch:Channels WHERE \`Name\` == "follow-ups"]->)
    if channel == null { ERROR("no #follow-ups channel") }
    write channel-[:Messages]-> { Message: \`Suggested Action\` }
  }
}
`,
    },
    {
      construct: 'AI() values and file-scope prompt bindings (bare-name reads)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

\`Company Prompt\` = "the company name this email is about"

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name: AI(\`Company Prompt\`)
    Description: AI("summarise this message")
  }
}
`,
    },
    {
      construct: 'AI() tiers — how much thinking the answer is worth',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Triage\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name:        AI("the company name this email is about", "quick")
    Domains:     AI("the company's website", "careful")
    Description: AI("weigh this company against our thesis and say where it lands", "thorough")
  }
}
`,
    },
    {
      construct: 'EXISTS() tests, including hop WHERE filters',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  if EXISTS(m-[:Attachments]-> WHERE \`Name\` CONTAINS "pdf") {
    write crm-[:Companies]-> { Name: m.\`Subject\` }
  }
}
`,
    },
    {
      construct: 'COALESCE and the built-in function helpers',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name: COALESCE(m.\`Subject\`, "unknown")
    Description: UPPER(TRIM(m.\`Subject\`))
  }
}
`,
    },
    {
      construct: 'integration-provided functions as write-field values',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name: DOMAIN_OF(m.\`Subject\`)
  }
}
`,
    },
    {
      construct: 'integration functions outside a write field (invalid everywhere)',
      status: 'pending',
      flag: "non-built-in function calls",
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  if DOMAIN_OF(m.\`Subject\`) == "acme.dev" {
    write crm-[:Companies]-> { Name: m.\`Subject\` }
  }
}
`,
    },
    {
      construct: 'namespaced helper families (CURRENCY.*, DATE.*, TEXT.*) and bare coercers DATE()/DATETIME()/NUMBER()',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  if TEXT.REGEX_EXTRACT(m.\`Subject\`, "(DEAL-\\\\d+)") EXISTS {
    company = write crm-[:Companies]-> {
      Name:        TEXT.SLUG(m.\`Subject\`)
      Description: CURRENCY.GET_CODE_FROM_FIGURE(m.\`Body\`)
      \`Team Size\`: NUMBER(m.\`Body\`)
    }
    write company-[:Tasks]-> {
      Content:  "Follow up on \${m.\`Subject\`}"
      Deadline: DATE.ADD_DAYS(@current_date, 14)
    }
    write company-[:Notes]-> {
      Title:   "Received"
      Content: "\${DATE(@current_date)} / \${DATETIME(m.\`Body\`)} / \${DATE.FORMAT(@current_date, "MMMM D, YYYY")}"
    }
  }
}
`,
    },
    {
      construct: 'DATE.TODAY(zone) + DATETIME.AT(date, time, zone) — a zone-anchored window',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  berlin_today = DATE.TODAY("Europe/Berlin")
  win_end      = DATETIME.AT(berlin_today, "07:00", "Europe/Berlin")
  win_start    = DATETIME.AT(DATE.ADD_DAYS(berlin_today, -1), "07:00", "Europe/Berlin")
  company = write crm-[:Companies]-> { Name: m.\`Subject\` }
  write company-[:Notes]-> {
    Title:   "Window"
    Content: "\${win_start} → \${win_end} (\${berlin_today})"
  }
}
`,
    },
    {
      construct: 'FILE() artifacts as write-field values',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  digest = "From: \${m.\`Subject\`}"
  company = write crm-[:Companies]-> {
    Name: m.\`Subject\`
  }
  write company-[:Files]-> {
    File: FILE(digest, "pdf")
  }
}
`,
    },
    {
      construct: 'ambient values (@user_email, @actor_*, @current_date)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name:          m.\`Subject\`
    Description ?: "Owner: \${@user_email} — from \${@actor_name} on \${@current_date}"
  }
}
`,
    },
    {
      construct: "'== null' as a presence guard clause that narrows a maybe-absent FIRST() scalar",
      status: 'runs',
      probe: `
import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

function m(evt: <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->>) {
  evt-[co:Companies]-> {
    domain = FIRST(co.Domains)
    if domain == null { ERROR("no domain on this company") }
    write co { Description: domain }
  }
}
`,
    },
    {
      construct: 'READ a file into text, CHUNKS the text into pieces, extract over the pieces',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Cut A Document\`(go: <runs-[:Invocation]->>) {
  go-[f:Files]-> {
    text   = READ(f.\`File\`)
    pieces = CHUNKS(COALESCE(text, ""), { size: 40000, overlap: 2000 })
    found  = extract(pieces, node Company: "each company named in this text" { name: <text> "the company's name" })
    MAP(found, (c) => {
      write crm-[:Companies]-> {
        unique by (FUZZY \`Name\`)
        Name: c.name
      }
    })
  }
}
`,
    },
    {
      construct: 'closures — expression bodies, a closure bound to a name and called, calls nested in expressions with short-circuiting',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Summarise\`(m: <inbox-[:Email]->>) {
  inc     = (v: <number>) => v + 1
  shout   = (t: <text>) => UPPER(t)
  counts  = [1, 2, 3]
  doubled = MAP(counts, (x) => x * 2)
  bumped  = MAP(counts, inc)
  both    = inc(inc(3)) + COUNT(doubled) + COUNT(bumped)
  tag     = IF both > 4 THEN shout("big") ELSE "small" END
  name    = COALESCE(m.\`Subject\`, shout(m.\`Body\`))
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        name
    Description: "\${tag} \${both}"
  }
}

`,
    },
    {
      construct: 'MAP and FILTER with a settings record — onError, concurrency, initialConcurrency',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Tidy\`(m: <inbox-[:Email]->>) {
  lines = [m.\`Subject\`, m.\`Body\`]
  kept  = FILTER(lines, { onError: 'ignore' }, (t) => LENGTH(t) > 0)
  MAP(kept, { onError: 'warn', concurrency: 4, initialConcurrency: 1 }, (t) => {
    write crm-[:Companies]-> { unique by (\`Name\`) Name: t }
  })
}

`,
    },
    {
      construct: 'dict literals — spread of a dict and of a record, later keys winning, read with a dot',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

node Company: "each company named in this message" {
  name:    <text> "the company's name"
  website: <text | null> "its website, if given"
}

node Profile: "more about the company described last" {
  summary: <text> "one line on what the company does"
}

function \`Merge\`(m: <inbox-[:Email]->>) {
  base      = { stage: "Seed", source: "email" }
  row       = { ...base, stage: "Series A" }
  content   = [m.\`Body\`]
  companies = extract(content, Company, { tier: 'careful' })
  merged    = MAP(companies, (c) => {
    details = extractOne([...content, TEXT.SERIALISE(c, 'JSON')], Profile, { tier: 'careful' })
    return { ...c, ...details }
  })
  MAP(merged, (d) => {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:        d.name
      Description: "\${row.stage}: \${COALESCE(d.summary, "")}"
    }
  })
}
`,
    },
    {
      construct: 'list literals — spread of a list, spread of a walk read for a field, tuple indexing and tuples read as a list of a union',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Gather\`(m: <inbox-[:Email]->>, n: <number>) {
  pdfs    = m-[a:Attachments WHERE a.\`Content Type\` == "application/pdf"]->.\`File\`
  content = [m.\`Body\`, ...pdfs, "end"]
  inline  = [m.\`Subject\`, ...m-[a:Attachments]->.\`File\`]
  first   = AT(content, 0)
  mixed   = JOIN([m.\`Subject\`, n], " ")
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: "\${first} \${mixed} \${COUNT(inline)}"
  }
}

`,
    },
  ],
};
