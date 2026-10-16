import type { Chapter } from '../types';

export const reference: Chapter = {
  id: 'reference',
  title: 'Reference — the whole surface on one page (forms, operators, modifiers, pitfalls)',
  content: `## Reference — the whole surface on one page

A terse lookup, not a lesson. The teaching chapters explain *why*; this one is for refreshing a single rule mid-author — the exact spelling of an operator, the write modifiers, the \`unique by\` forms, a traversal head. Learn the language from the other chapters; come back here to check a detail. For one function's full entry — signature, presence, ordering, an example — the \`builtins\` chapter has a section per function (\`builtins#SUM\` for \`List.sum\`).

### top-level

\`\`\`
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters         # adapter types
import { acme_main } from credentials          # stored connections, by saved name
import { fetchUrl } from plugins              # functions the platform ships, called with named arguments
import { \`Log Lead\`, Lead } from "lib/intake"  # exported declarations, by file path
import { \`Files Out\` as send } from "lib/out"  # rename on import with: as

inbox = connect email                                # no credential
crm   = connect attio using acme_main          # with a credential
crm   = connect attio using acme_main { dryRun: true }   # dryRun is universal

prompt = "the company this email is about"     # file-scope binding

function \`Intake\`(m: <inbox-[:Email]->>) { … }  # declaration; one typed parameter — the email ITSELF (read \`m.Subject\` straight off it)
export function \`Log Lead\`(l: <Lead>) { … }    # shared across files
export node Lead { Name: <text> }              # a named structure; nest \`node <edge> { … }\` for related records
node Lead: "each lead" { Name: <text> "their name" }   # described: \`extract(content, Lead)\` uses its fields and words
node Contact extends Lead { Email: <text> }    # Lead's fields and nested nodes, then its own; redefining one is refused
type Thesis = <"Consumer" | "Infra">           # a written set of values: an annotation, and an extract constraint

listen to inbox { key: "intake" } fire intake  # the one way an automation runs
\`Log Lead\`(graph<Lead> { Name: msg.Subject })  # call a function; arguments are positional
doc = \`Email To Doc\`(msg)                      # a call's value: what the callee returned
function \`Label\`(name: <text>, tags: <text[]>, cfg: <{ prefix: text, suffix?: text }>) { … }   # value parameters; convention: data, then a function, then a settings record last
msg = graph<Message> { Body: m.Body, Files: m-[a:Attachments]-> { Name: a.Name } }   # a record built in memory, checked against a declared shape
return { title: msg.Subject, n: 2 }            # hand a value out of a body — several results in one dict or graph
f = (day: <date>) => { … }                     # a closure: a body run later, holding what was in scope here
inc = (v: <number>) => v + 1                   # an expression body; a closure bound to a name is called like any function: inc(2)
\`\`\`

\`=\` binds a name (instance, handle, extract graph, a bound block, a call's value, a closure, a plain value). Statements run top-to-bottom; a handle must be written before it is read. A function may call itself, declaring what it returns (\`f(n: <number>): <number>\`). A listened automation takes exactly one parameter; a library automation takes any number.

\`return\` is the one way a value leaves a body — an automation's, a block's, or a closure's — and a \`return\` inside an \`if\` arm belongs to the body around it. A body with no \`return\` hands nothing back, so it runs as a statement and cannot be bound. A closure is a value but not data: keep it in a variable, hand it to \`callback\`, \`until\`, \`race\` or \`all\`, or pass it to a parameter whose type is a closure type (\`<(c: <Company>) => <text>>\`) — never in a list, under a key or in a field.

### types-and-brackets

Types **always** wear angle brackets; positions, scalar values, and handles **never** do.

- Brackets: automation params (\`m: <inbox-[:Email]->>\`, \`root: <crm>\`), extract field annotations (\`amount: <number>\`, borrowed \`stage: <crm-[:Requests]->.Stage>\`), declared fields (\`Name: <text>\`), \`is\` tests (\`rec is <crm-[:Companies]->>\`), explicit polymorphic targets (\`match a-[:related]-><Companies> { … }\`).
- No brackets: write targets (\`write crm-[:Companies]->\`), traversal hops and edge names, \`unique by\` components, call arguments, per-family answer types (a \`Check\` answers boolean, a \`Provide\` answers whatever its \`Answer Type\` names — no bracket-generic syntax).
- Primitives: \`<text>\`, \`<number>\`, \`<boolean>\`, \`<date>\`, \`<datetime>\`, \`<file>\`, \`<json>\`. Borrowed path: \`<instance-[:record_type]->.field>\`. An extract or declared field may add \`| null\` (\`<text | null>\`): a missing one arrives null.
- Declared refinement: \`type Thesis = <"Consumer" | "Infra">\` at file scope, then \`<Thesis>\` anywhere a type goes. It constrains an extraction to those values, tells the model which to pick from, and flags a literal that is not one of them; the values are ordinary text everywhere else.
- \`<json>\` is a **structured value** — an object or list literal written verbatim into a field that takes one (a system's own rich-message document; its chapter names the field). Opaque: pass it through, never operate on it. Keys inside an object literal are comma-separated; a write body's fields are newline-separated.

### naming-and-backticks

- **Bare** identifier — a single word with no spaces: \`msg.Subject\`, \`Name:\`, \`Owner\`, \`company.url\`.
- **Backticks** wrap any name with spaces, *anywhere it appears*: a field (\`msg.\`Sender Name\`\`), a write target's edge (\`write crm-[:\`Sales Pipeline\`]->\`), a declared node (\`node \`Deal Intake\` { … }\`, \`rec is <\`Deal Intake\`>\`), a credential or automation name, and a field read through an alias inside \`WHERE\` / \`ORDER BY\` (\`c.\`Created At\`\`).
- **Double quotes are always a literal string.** \`Name: "Subject"\` writes the word "Subject"; a field read needs a position — \`Name: msg.Subject\`.
- Keep the names you coin bare (binding names, import aliases) — backticks work there too, but bare reads best. Alias an awkward credential name to a bare one on import.

### operators-and-functions

- Compare: \`==\` \`!=\` \`<\` \`<=\` \`>\` \`>=\`. Binding is \`=\` (never a comparison). Logic outside walk brackets: \`&&\` \`||\` \`!\`, \`x != null\`, \`exists(walk)\` (related records only), \`rec is <type>\`. Inside walk brackets it is SQL: \`AND\` \`OR\` \`NOT\` \`CONTAINS\` \`IN\` \`IS\` \`EXISTS(…)\`, and a field is read through the alias.
- Containment outside brackets: \`Text.includes(x, "pdf")\` on text, \`List.includes(xs, v)\` on a list.
- \`is\` also takes a declared node (\`rec is <Contact>\`): true when the record carries every field that structure declares — nested nodes don't gate it, extras allowed. Narrows the same way.
- Aggregates / lists: \`Text.concat(a, b)\`, \`coalesce(a, b)\` (first non-empty), \`only(…)\` (the one that matched — fails the run on more than one), \`count(…)\` (a walk or a list), \`List.sum(…)\`, \`List.avg(…)\` (always present), \`List.min(…)\`, \`List.max(…)\` (\`T | absent\`), \`List.from(…)\`, \`List.compact(a, b)\` (flat, nulls dropped), \`Text.join(list, ", ")\`, \`sort(list)\` / \`sort(list, { order: "desc" })\` / \`sort(list, (r) => r.score)\` / \`sort(list, (r) => r.score, { order: "desc" })\`, \`[a, b]\` (list literal). \`Text.join\` / \`first\` / \`List.last\` / \`xs[n]\` need a sequence: a \`sort\`, an \`ORDER BY\` on the hop, or a relationship the source keeps in order.
- Dicts: \`{ k: v }\` (dict literal, text keys only), \`d.k\` or \`d["k"]\` (lookup — present for a key the literal wrote, refused for one it did not, \`T | absent\` for a computed key or a dict of unknown shape). \`xs[n]\` — a number index, \`T | absent\`, same ordering need as \`first\`.
- Calls nest inside any expression and run left to right, arguments before the callee; \`c ? a : b\`, \`&&\`, \`||\` and \`coalesce\` short-circuit; a call that may wait is only for a statement on its own line. A list literal is a tuple and can splice with \`...list\` (including a walk read for a field, \`...m-[a:Attachments]->.File\`). \`Json.stringify(value)\` writes a value out as text for a prompt.
- Value iteration (each takes a function, \`(member) => { return … }\` or \`(member) => expression\`): \`map(list, f)\` and \`map(list, f, { onError: "warn", concurrency: 4, initialConcurrency: 1 })\` (alone may skip \`return\`; legal as a bare statement too; \`filter\` takes the same settings), \`filter(list, f)\`, \`reduce(list, f, start)\` (needs an ordered list; \`f\` is \`(carried, member)\`), \`List.groupBy(list, key)\` → dict of lists, \`List.keyBy(list, key)\` → dict of members (a repeated key fails the run). The function may \`await\`: each member waits on its own, and the op finishes once every member has.
- \`members(<T>)\` — a closed type's values, in declaration order. Refused on a known-values (open) field.
- Value-level conditional: \`cond ? a : b\` (the \`if\` statement branches statements).
- Strings: double-quoted, may span newlines, and interpolate with \${…} — including directly inside a call argument, e.g. \`ai("the company in \${msg.Subject}")\`. An interpolated \`T | absent\` value prints as nothing.
- \`ai("…")\` — a value from a language model; it sees only the prompt, so interpolate the context in. Optional second arg is the settings record, whose \`tier\` is \`"quick"\` (default), \`"careful"\` or \`"thorough"\`. Resolves to a real null when nothing applies — gate with \`x != null\`.
- Text and number helpers (always there): \`Text.trim\` \`Text.lower\` \`Text.upper\` \`Text.length\` \`Text.from\` \`Text.split\` \`Number.abs\` \`Number.round\` \`Number.floor\` \`Number.ceil\` \`Number.parse\`. A list's length is \`count(xs)\`.
- Unary minus: \`-x\`, \`-(a + b)\` — arithmetic negation; the traversal \`-[\` form is unrelated.
- Remainder: \`a % b\` — same precedence as \`*\` \`/\`, TypeScript semantics (the sign follows the dividend: \`-7 % 20\` is \`-7\`).
- Coercers: \`Date.from(v)\`, \`DateTime.from(v)\`, \`Number.parse(v)\`.
- Namespaces (deterministic, \`Namespace.member(…)\`): \`Currency.numberFromFigure\`, \`Currency.codeFromFigure\`, \`Currency.formatFigure(number, code)\` → \`text | absent\` (a money figure, the inverse of \`numberFromFigure\` — a symbol where the code has one, the code after a space where it doesn't), \`Date.parse\`, \`Date.addDays\`, \`Date.format(value, "MMMM D, YYYY")\`, \`DateTime.toIso\`, \`Date.today("Europe/Berlin")\`, \`DateTime.at(date, "07:00", "Europe/Berlin")\`, \`Text.regexExtract\`, \`Text.slug\`, \`Text.pairs(record, separator?)\` → \`text\` (\`key=value\` pairs in written order, joined by \`separator\` — default \`" | "\` — nested nodes/edges skipped), \`Url.host(text)\` → \`text | absent\` (the host, lowercased, \`www.\` kept — takes a full URL or a scheme-less address like \`acme.com\`; absent for an email or text naming no address), \`Number.format(number, "compact" | "grouped")\` → \`text | absent\` (\`"compact"\` abbreviates with K/M/B/T, \`"grouped"\` adds thousands separators — the style is a checked literal).
- Time zones: \`Date.today(zone)\` is the day it is there (the run's firing moment, one answer per run); \`DateTime.at(date, time, zone)\` is the instant a wall-clock time names there. Move days with \`Date.addDays\` on the date and anchor each end of a window separately — daylight saving then takes care of itself. Zone and time are literals, checked when you save.
- File artifact: \`File.from(content, "pdf" | "text")\`. The other way: \`File.read(file)\` → \`text | absent\`.
- Text pieces: \`Text.chunks(text, { size, overlap })\` → a list of text, each piece at most \`size\` characters; \`unit:\` takes \`"chars"\` and nothing else. \`{ entities: 20 }\` in place of \`size\` cuts on whole lines by the records a piece is expected to yield; exactly one of the two is written.
- Integration functions (e.g. a target's own message builder) run **only as the value of the write field that advertises them**.

### meta-fields

\`@\`-prefixed values from the run itself; read like any other value. Eight, in three groups:

- Time: \`@current_date\` (\`YYYY-MM-DD\`), \`@current_timestamp\`.
- Responsible user (forwarder-resolved — *whose work is this*): \`@user_email\`, \`@user_name\`, \`@user_id\`.
- Raw originator (*who literally sent this*, unresolved): \`@actor_email\`, \`@actor_name\`, \`@actor_id\`.

A meta-field the run can't resolve is simply empty.

### writes

\`\`\`
company = write crm-[:Companies]-> {
  Name:      msg.Subject      # plain — overwrites every run
  Owner   ?: @user_email      # set-if-empty — leaves an existing value alone
  Tags    +: ["inbound"]      # append to a multi-value field (duplicates allowed)
  Sources +?:["email"]        # append only what's missing (set-union)
  ?...e                       # every field of e (extracted, <Decl>-typed, or a graph), set-if-empty; \`...e\`: plain
  unique by (Domain)          # identity — repeats update instead of duplicate
}
\`\`\`

\`unique by\` forms:
- \`unique by (Domain)\` — one component.
- \`unique by (\`First Name\`, \`Last Name\`)\` — comma = AND (all must match).
- two \`unique by\` lines — OR of the AND-groups.
- \`unique by (parent, Stage)\` — a handle component scopes identity to that parent.
- \`unique by (FUZZY Name)\` — similarity match (when the target supports it).
- \`unique by (Domain, FUZZY Name)\` — mix exact and fuzzy.
- \`unique by (parent, Stage == "Seed")\` — a component pinned to a value.
- \`unique by (Name, Updated WITHIN 30d)\` — a non-equality component narrows the candidates its own line's key found; it reads only the candidate's fields (a missing field fails it, except \`!=\`). Test anything else on the target's \`WHERE\`.

Connecting records (write related records **along their edges**, never as flat rows):
- \`write company-[:Notes]-> { … }\` — linked write off a parent handle.
- \`write (a-[:agreements]->, b-[:agreements]->) { … }\` — one record under several parents; \`unique by (a, b)\`.
- \`link champion -[:led]-> part\` — connect two records already bound.
- \`p = match c-[:portfolio]-> { unique by (Name), Name: "Fund III" }\` — find by identity, never create or write; the result is the record or absent, so test it (\`if (p != null) { … }\`) before reading it.
- \`match crm-[c:Companies WHERE EXISTS(c-[:Team]->)]-> { … }\` — a \`WHERE\` on the target's final hop limits which existing records may be matched (\`write\` still creates when none is left).
- \`if (p != null) { link c -[:portfolio]-> p }\` — \`match\` first, then link the guarded record.
- \`write record { Status: "Customer" }\` — in-place update of a held/traversed record (no \`unique by\`).
- \`unlink a -[:related]-> b\` — sever an edge. \`delete stale\` — remove a record (only when removal is the automation's purpose).

A reference field set by assigning a handle (\`Partner: pa\`) is rejected — use the structural forms above. Required fields must all be set on a create.

### traversal-and-query

Repetition is a position-valued path followed by a block — there is no loop keyword.

\`\`\`
msg-[a:Attachments]-> { … }                       # block; a names this item's position
msg-[f:Attachments WHERE f.type == "application/pdf"]-> { … }   # hop filter
msg-[:Sender]->.Name                              # terminal read off a hop
alias-[:edge]->-[:edge]->                          # chained hops
crm-[c:Companies WHERE c.Stage == "Open" ORDER BY c.\`Created At\` DESC LIMIT 10]-> { … }   # query
\`\`\`

- \`ORDER BY <key>\` with \`ASC\` (default) or \`DESC\`, where the key is a field of the records the hop yields or any expression over one of them (\`ORDER BY p-[:Company]->.Name\`); \`LIMIT n\` (pair it with an \`ORDER BY\` unless the relationship is ordered by nature); \`WITHIN 30d\` (\`d\` / \`h\` / \`w\` recency).
- Binding a block collects what its iterations \`return\`ed: a returned value gives a **list**, one entry per item (\`names = … { return c.name }\` then \`Text.join(names, ", ")\`); a returned record gives those records, walked like any position (\`orgs = … { return write … }\` then \`count(orgs)\`, \`orgs-[n:Notes]-> { … }\`). No \`return\`, nothing to bind.
- A block alias does not exist outside its braces. Whether a filter pushes down to the source or runs in-app is the source's call, not yours.

### branching

\`\`\`
if (Text.includes(msg.Subject, "order")) { … } else if (rec is <crm-[:People]->>) { … } else { … }
fail("unexpected record kind")                   # abort the whole run with a reason
\`\`\`

\`==\` compares (not \`=\`). An \`else\` already means "not the if" — don't re-test it. A plain \`if\` with no \`else\` already does nothing; keep \`fail(…)\` for genuine failures.

### presence

\`\`\`
n = only(company-[t:Notes WHERE t.Title == "Brief"]->)   # T | absent — a lookup that might match nothing
d = first(company.Domains)                 # T | absent — same, over a field
if (n == null) { fail("no notes found") } # guard clause — n is present for every line after
if (n != null) { … }                       # narrows n present INSIDE this arm only
x = d != null ? "\${d}" : ""                # narrows d present in the true arm only
Field ?: d                                 # '?:' takes a maybe-absent value, no guard needed
\`\`\`

\`first\`/\`List.last\`/\`List.min\`/\`List.max\`/\`xs[n]\` over anything that can come up empty, and a named \`match\` that found nothing, type \`T | absent\`, same as an \`await first(…)\` on a landing a cancel can settle empty. Using such a value where a present one is required — a write or traversal target, a dot-plane field read, an ordered comparison (\`<\` \`<=\` \`>\` \`>=\`) — is refused until narrowed, naming the fix. \`==\`/\`!=\` against \`null\` is the presence test (loose: \`null\` and absent mean the same thing); against any other value a maybe-absent side needs no guard (absent is never equal to a present value), and a condition (\`if\`, \`? :\`, \`&&\`/\`||\`/\`!\`) reads a missing boolean as false. Both sides must still match in kind. \`exists(…)\` is only for related records (\`exists(msg-[:Attachments]->)\`); for a value, \`x != null\` and \`x == null\` take a bound name or a field read off one (\`x.Field != null\`), and a proven field proves the record it came off.

### listeners

\`\`\`
listen to inbox { key: "intake" } fire intake
listen as "Nightly digest" to timer { schedule: "0 9 * * 1" } fire \`Weekly Digest\`   # 5-field cron, UTC
listen to crm { events: ["record.created"] } fire \`On New\`
listen to crm { events: ["record.created", "record.updated"] } fire mirror
listen to go {} fire \`On Run\`                      # manual / on-demand (go = connect manual)
\`\`\`

Connect the instance first, then listen to *it*. The \`as\` alias goes right after \`listen\`, before \`to\`. A manual run *is* the submit-text/files channel: read \`go.Text\` and traverse \`go-[:Files]->.File\` (both optional). Pausing = commenting the \`listen\` line out. There is no \`run\` statement.

### reviews

Connect with \`connect ask\`, **write** a question along a family edge (the record mints a readable \`Url\`), deliver the \`Url\`, then **await** its \`Response\`. Families: **Check** (approve/decline → boolean), **Provide** (supply a value — set \`Answer Type\`), **Choose** (one of \`Options\` — buttons), **Select** (a subset of \`Options\` — checklist), **Review** (acknowledge and move on), **Form** (collect named values — literal \`Fields\` type the answer). Every family takes \`Prompt\`, optional \`Detail\`.

\`\`\`
asks = connect ask
q = write asks-[:Check]-> { Prompt: "Pursue this?" }
ops = only(team-[ch:Channels WHERE ch.Name == "ops"]->)
if (ops == null) { fail("no #ops channel") }
write ops-[:Messages]-> { Message: "Decide: \${q.Url}" }    # deliver the link
answer = await first(q-[:Response]->)                       # park until answered
if (answer.Answer) { … }

# Timeout / escalation are COMPOSED from race + sleep (no fallback clause):
r = race(
  () => { a = await first(q-[:Response]->)
          return a.Answer },
  () => { await sleep(2d) },          # the default when nobody answers in time
)
if (r[0] == null) { … }             # nobody answered — the safe default path
if (r[0] == true) { … }             # approved

r2 = all(f, () => { … }) # all at once, every slot filled
\`\`\`

The answer is readable only **after** \`await first(q-[:Response]->)\`. Durations: \`30s\` \`90m\` \`4h\` \`1d\` \`1h30m\`. Interpolate \${q.Url} into the delivery message or nobody can answer. \`Response\` is an ordinary writable edge, so anything that can write can answer it — including an in-chat button: mint a \`callback\` per answer and carry its \`id\` on the control (which field on a control holds it is that system's own, and its chapter names it); see \`in-chat-answers\` in the reviews chapter for the full shape. An \`await\` on its own waits forever — race it against \`sleep\` for an unattended run.

\`await\` marks the wait itself — \`await first(q-[:Response]->)\`, \`await sleep(2d)\` — and \`race(…)\` only says how several waits combine (the first one), so it is written without \`await\`: its arms wait, and the run parks where they do. An arm is a **function**, passed as an argument — \`() => { … }\` in place, or the name of one declared elsewhere — taking no parameters and capturing everything in scope where it is written. The value is a receipt of one slot per arm in the order written, read as \`r[<index>]\` and holding what that arm \`return\`ed: only the arm that settled first has its slot filled, so a null test on a slot is the branch (arms settling in the same moment all land, and arms still parked are dropped where they stand — what they had already done stays done). To wait for **every** one, use \`all\`: \`r = all(f, g)\` runs them at once, needs no \`await\` (an arm that waits parks the run), and \`r[i]\` is what function \`i\` returned, every slot filled. \`all(f, g, { concurrency: 1, onError: "warn" })\` takes \`map\`'s settings: how many run at once, and whether a failing arm leaves its slot null instead of failing the run. A function that hands nothing back has an always-null slot either way.

\`\`\`
cb = callback({ … })                      # id + url; one use, dies with the run
cb = callback({ … }, { once: false, ttl: 2d })          # repeatable / time-bounded
cb = callback((day: <date>) => { … })     # a value supplied when someone acts
cb = callback(() => \`Chase\`(company))         # defer a call
await first(cb-[:Called]->)               # wait for it (landing: At + one field per parameter)

await until(() => { refresh co; return co.Stage == "Won" }, { every: 1h })   # re-check a condition on a cadence
\`\`\`

\`cb.id\` goes in a control's payload; \`cb.url\` is the link form (its page confirms before it acts). \`until\` re-checks its condition every \`every:\` (1m floor) and resumes when it holds; the condition is a closure or a plain boolean expression, reads only, and takes no parameters. \`refresh <handle>\` re-reads a written record so the next check sees it as it is now. Neither a callback's body nor an \`until\` condition may wait, directly or through a function it calls: a run cannot be resumed there (\`MOV_WAIT_NOT_RESUMABLE\`). Do the waiting in the automation itself, outside both.

### extraction

\`\`\`
companies = extract([msg.Body, ...msg-[a:Attachments]->.File], Company, { tier: "careful" })   # a list of Company records
details   = extractOne([...content, Json.stringify(c)], CompanyDetail, { tier: "careful" })   # the single record, or absent
people    = extract(content, node Person: "each person named" { name: <text> "their name" })   # a shape written in place
page      = fetchUrl(url: c.website)                                                         # a plugin: named arguments, absent when it finds nothing
\`\`\`

Content is a list (shared content first, record-specific content last, so repeated calls hit the prompt cache); the shape is a declared \`node\`; settings are \`tier\` (\`"quick"\` / \`"careful"\` / \`"thorough"\`), \`model\`, \`effort\`. The description carries cardinality ("the company" = one; "each company" = all). \`map(…, f, { initialConcurrency: 1 })\` warms the cache before the fan-out. An extraction writes nothing — writes are separate statements.

### pitfalls

- **Quoting the wrong way.** \`Name: "Subject"\` writes the word; a read needs a position — \`msg.Subject\`.
- **\`=\` in a condition.** Comparison is \`==\`; \`=\` binds names.
- **Comparing across types.** \`==\` / \`<\` / … only make sense within one kind — coerce one side (\`Date.from(…)\`, \`Number.parse(…)\`).
- **Joining strings with \`+\`.** \`+\` is arithmetic; a non-numeric operand is refused when you save. \`"\${…}"\` interpolation is the string-building form (\`Text.concat\` also works; interpolation reads as what it produces).
- **\`ai\` where a plain read or a namespace function works.** Read the field, or use \`Date.\` / \`Currency.\` / \`Text.\` for deterministic jobs.
- **A bare name from nowhere.** Everything is imported, bound, or a parameter.
- **Guessed type or field names.** Targets are workspace-specific (\`crm.Company\` vs \`crm.Companies\`) — read the live schema.
- **Reading before binding.** A handle bound later cannot be read earlier; reorder.
- **Forgetting \`unique by\` on entity targets.** Anything a later event can mention again needs identity, or you mint duplicates.
- **\`:\` where you meant \`?:\`.** Plain \`:\` overwrites every run; owner-style fields want set-if-empty.
- **Assigning handles to reference fields.** \`Partner: pa\` is rejected — use a linked / tuple target or \`link\`.
- **Writing into a declared \`node\`.** A declaration names a structure, not a system that stores anything — build the record with \`graph<Shape> { … }\` and pass that.
- **Leaving related records unconnected.** The most common and costly miss: after the run, every related record should end up attached, not standalone.
- **Writing fields in a \`match\` body.** A match finds; it never writes. To update, use \`write … unique by\`.
- **Reaching for a loop.** Enumeration is a traversal-headed block, not a loop.
- **Using an alias outside its block.** \`return\` what the rest of the automation needs from the block.
- **Listening to an adapter type instead of an instance.** Connect first; listen to the instance.
- **Reading a review's answer before it exists.** The answer binds only after \`await first(q-[:Response]->)\`, and once resolved.
- **Writing \`await\` in front of a bare walk.** The wait is the \`first\` read, held until there is something to read: \`await first(q-[:Response]->)\`, never \`await q-[:Response]->\`.
- **Running several functions at once.** \`race(f, g)\` takes the first to finish and \`all(f, g)\` every one. The arms are the call's arguments, with no \`await\` in front: the wait is the \`await\` inside an arm. An arm is \`() => { … }\` or the name of a declaration; a plain value or a bare block is refused when you save.
- **Leaving an unattended review with no timeout.** An \`await\` on its own waits forever; race it against \`() => { await sleep(2d) }\` so a default takes over when time runs out.
- **Expecting one extraction per piece from a list.** \`extract(pieces, Shape)\` reads them all as a single job; \`map(pieces, (p) => extract([p], Shape))\` is the per-piece form.
- **Verifying from the target system only.** The run record shows what was sent and why; read provenance before editing the automation.
- **Using a maybe-absent value unguarded.** A write/traversal target, a link end, a dot-plane field read, or an ordered comparison off a \`first\`/\`List.last\`/\`List.min\`/\`List.max\`/\`xs[n]\` result or a named \`match\` is refused until narrowed — guard with \`if (x == null) { fail(…) }\` (or an \`else\` arm), \`x != null\`, or \`?:\` on the write field.
- **Binding a field just to test it.** \`x.Field != null\` reads the field directly; no intermediate binding.
- **Keeping a closure as data.** A closure lives in a variable or a parameter, or is passed as an argument where it is written (\`map(xs, (x) => …)\`, \`all(f, g)\`, a callback's subject). In a list, under a key, in a field or as what a \`map\` returns it is refused when you save.
- **Calling something that may not be a function.** A name is called when its type shows it is a closure (\`g = label\` then \`g()\`, a closure-typed parameter); a value that may be something else is refused when you save.`,
};
