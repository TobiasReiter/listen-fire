import type { Chapter } from '../types';

export const builtins: Chapter = {
  id: 'builtins',
  title: 'Builtins',
  content: `## Builtins — every function and helper family, one entry each

Every built-in function, one section each — fetch one by name (\`builtins#List.sum\`) instead of the whole chapter. Each entry gives the signature, what it means, whether the result is always there or \`T | absent\`, an ordering requirement where one exists, and an example. The reference chapter's *operators-and-functions* is the one-page version of this list. Entries run in groups: the core words, then each namespace with its members. Core words are always there and never qualified; a namespace member is always written with its namespace (\`Text.upper(x)\`). Every argument is checked when you save, and a call is typed by what it gives back (\`Text.upper(x)\` is text), so a built-in's call written into a number field is refused. A call can sit inside any expression and runs left to right.

Inside walk brackets \`-[…]->\` these functions are spelled in capitals: \`LOWER UPPER TRIM LENGTH ABS ROUND FLOOR CEIL DATE DATETIME NUMBER COALESCE EXISTS\`, as in \`ch-[m:Messages WHERE LOWER(m.Text) CONTAINS "urgent"]->\`. Each section is headed by the name you write outside brackets (\`Text.upper\`, \`List.sum\`), which is what you fetch it by; the capitals names above are only the spellings inside walk brackets.

## Core words

### x == null

\`x == null\` → \`boolean\`, always present — the presence test inverted (\`x != null\` is true when there is a value). Takes a bound name or a field read off one (\`x.\`Field\` == null\`), and proving a field absent proves nothing about the record it came off — proving it *present* (\`!= null\`) is what narrows the record.

\`\`\`
if (\`Suggested Action\` == null) { fail("nothing to act on") }
\`\`\`

### exists

\`exists(walk)\` → \`boolean\`, always present — whether a relationship has any records. Takes a walk only, with an optional \`WHERE\` through an alias (\`exists(m-[a:Attachments WHERE a.Name CONTAINS "pdf"]->)\`); on a value it is refused with the \`!= null\` rewrite. \`!exists(…)\` is has-none. \`if (x != null) { … }\` narrows \`x\` present *inside that arm only*; \`x != null ? a : b\` narrows the same way inside \`a\`.

\`\`\`
if (exists(msg-[:Attachments]->)) { … }
\`\`\`

### coalesce

\`coalesce(a, b, …)\` → the first argument with a value, present whenever at least one argument is unconditionally present (a literal, or anything already known to be there). It stops at the first argument that has a value and never evaluates the rest, so a later argument that calls a model, reads a file or fails the run does nothing when an earlier one is present. A \`coalesce\` whose arguments might *all* be empty is itself \`T | absent\` and discharges nothing.

\`\`\`
Name: coalesce(msg-[:Sender]->.Name, msg-[:Sender]->.Email, "unknown")
\`\`\`

### count

\`count(list | walk)\` → \`number\`, always present, reads any order. The member count; \`0\` for null.

\`\`\`
n = count(co-[t:Team]->)
\`\`\`

### only

\`only(list | walk)\` → \`T | absent\`, reads any order — *the one that matched*: answers that record or value, and fails the run if there turns out to be more than one. Reach for it whenever a \`WHERE\` narrows to a single thing; over a bare walk it binds the whole record.

\`\`\`
channel = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
\`\`\`

### first

\`first(list)\` → \`T | absent\` — needs an ordered sequence, refused otherwise (the message points at \`only\` when the source is really a single-match lookup).

\`\`\`
newest = first(crm-[c:Companies ORDER BY c.\`Created At\` DESC]->.Name)
\`\`\`

### sort

\`sort(list)\` / \`sort(list, { order: "desc" })\` / \`sort(list, (r) => r.score)\` / \`sort(list, (r) => r.score, { order: "desc" })\` → the same members in order, always present (commutative — reads any order in). Plain values sort by themselves; a list of records or dicts takes a key function reading one field. The settings record is last, and \`"asc"\` is the default order.

\`\`\`
ranked = sort(rows, (r) => r.score, { order: "desc" })
\`\`\`

### map

\`map(list, f)\` or \`map(list, f, settings)\` → a list of what \`f\` returned, member by member, in the order given — always present (each slot may itself be absent when \`f\`'s value is). \`f\` is a function \`(member) => { … }\` or \`(member) => expression\` and takes its parameter's type from the collection; it may \`await\` (each member waits on its own). \`map\` alone among the five may skip \`return\` — each slot is then absent and the closure's writes still run — and a bare \`map(...)\` with no binding is a legal statement on its own.

\`\`\`
bulleted = map(lines, (t) => { return "• \${t}" })
upper    = map(lines, (t) => Text.upper(t))
map(ch-[m:Messages]->, (m) => { write graph-[:note]-> { text: m.Text } })
\`\`\`

\`settings\` is a record written in place, last: \`onError\` (\`"error"\`, the default, \`"warn"\` or \`"ignore"\`: what a member whose function fails does — the other two leave it out of the answer, \`"warn"\` with a warning on the trace), \`concurrency\` (members run at once) and \`initialConcurrency\` (a first batch of that size runs to the end before the rest start, so a prompt cache is warm before the fan-out). The answer stays in input order, and members writing the same \`unique by\` key take turns, so the record is made once. See *map-and-filter-settings* in the expressions chapter.

### filter

\`filter(list, f)\` or \`filter(list, f, settings)\` → the members \`f\` answered \`true\` for, in order, always present. \`f\` must give a boolean — \`return\` one, or write the condition as the body. \`settings\` is the same record \`map\` takes; a member whose predicate fails is not kept.

\`\`\`
kept = filter(lines, (t) => { return Text.length(t) > 0 })
\`\`\`

### reduce

\`reduce(list, f, start)\` → whatever \`f\` last returned, always present when \`start\` is. Needs an ordered list — \`f\` is \`(carried, member) => { … }\` and must \`return\` the next carried value.

\`\`\`
total = reduce(lines, (carried, t) => { return carried + Text.length(t) }, 0)
\`\`\`

### members

\`members(<T>)\` → a list of a **closed** type's values, always present, in the order they were **declared** — a refinement you wrote, or a field's option set borrowed from a system. Refused on a field whose values are merely *known* (other values are legal there too), since that has no complete membership.

\`\`\`
theses = members(<Thesis>)
\`\`\`

### ai

\`ai("…")\` → a value from a language model, resolving to a real null when nothing applies — gate with \`!= null\`. Optional settings record last: \`{ tier: "quick" }\` (default), \`"careful"\`, \`"thorough"\`. See *ai* in the expressions chapter for the full treatment — prompting, tiers, and the null-gating idiom.

\`\`\`
Category: ai("one of: bug, feature, question — for: \${msg.Subject}", { tier: "careful" })
\`\`\`

## Operators and indexing

### conditional

\`c ? a : b\` — the value-level conditional; \`if (c) { … }\` branches statements instead. The \`: b\` is required, so a conditional always has a type. Only the arm that is taken is evaluated, so a call in the other arm never runs. The condition guards its own \`a\` the way a statement \`if\` guards its arm, so a presence test on the condition narrows inside \`a\` only.

\`\`\`
line = domain != null ? "\${domain}" : ""
\`\`\`

### unary minus

\`-x\` → \`number\` — arithmetic negation. The operand must already be a number that is there: coerce first if it isn't (\`-coalesce(Number.parse(x), 0)\`), and narrow or \`coalesce\` one that may be absent. Parenthesise a sub-expression the same as any arithmetic: \`-(a + b)\`.

\`\`\`
delta = -(after - before)
\`\`\`

### remainder

\`a % b\` → \`number\` — same precedence as \`*\` and \`/\`, left-associative. TypeScript semantics: the sign follows the dividend (\`-7 % 20\` is \`-7\`, not \`13\`). Both operands must already be numbers that are there (narrow or \`coalesce\` one that may be absent), the same rule every arithmetic operator has; division by zero answers \`null\`.

\`\`\`
leftover = amount % batch_size
\`\`\`

### xs[i]

Indexing, by what you index. \`xs[n]\` → \`T | absent\` — a number index into a list, needing an ordered sequence exactly as \`first\` does (refused otherwise). A list literal is a tuple, so \`[a, b][0]\` reads the first slot exactly and is always present. \`d.k\` → present when \`k\` is one of the dict's own written keys (a typo is refused with a did-you-mean). \`d[key]\` → \`T | absent\` when the key is computed at run time, or when the dict's per-key shape isn't known (a system value, a \`List.groupBy\`/\`List.keyBy\` result — its keys are data, not declarations).

\`\`\`
top    = sort(names)[0]
copy   = { intro: "Welcome", body: "…" }
bucket = copy.intro
\`\`\`

## Text

### Text.trim

\`Text.trim(text)\` → the text with leading and trailing whitespace removed. Null in, null out.

\`\`\`
name = Text.trim(msg.Subject)
\`\`\`

### Text.lower

\`Text.lower(text)\` → the text, lowercased. Null in, null out.

\`\`\`
key = Text.lower(msg.From)
\`\`\`

### Text.upper

\`Text.upper(text)\` → the text, uppercased. Null in, null out.

\`\`\`
code = Text.upper(Text.trim(msg.Subject))
\`\`\`

### Text.length

\`Text.length(text)\` → \`number\`, always present — the character count of a text (an emoji is one character). \`0\` for null. A list's length is \`count(xs)\`.

\`\`\`
big = Text.length(msg.Body) > 500
\`\`\`

### Text.from

\`Text.from(value)\` → the value's text form. Null in, null out — a number, date, or boolean prints as its usual text; a record or list is refused (write a field off it instead).

\`\`\`
label = Text.from(amount)
\`\`\`

### Text.split

\`Text.split(text, separator?)\` → a list of text, always present (empty when the text is empty). Each piece is trimmed and empty pieces are dropped; \`separator\` defaults to \`","\`.

\`\`\`
tags = Text.split(msg.Subject, ";")
\`\`\`

### Text.concat

\`Text.concat(a, b, …)\` → \`text\`, always present — joins its arguments as text. A part that is \`T | absent\` is accepted and prints as nothing, the same rule interpolation follows (\`"\${x}"\` desugars to this same call). A structured value (a dict, a record) is refused — write a field off it first.

\`\`\`
line = Text.concat(msg.From, " — ", msg.Subject)
\`\`\`

### Text.join

\`Text.join(list, separator)\` → \`text\`, always present — the separator is text written in place (\`", "\`), never a name or a template. Needs an ordered sequence (an \`ORDER BY\` on the hop, a relationship the source keeps in order, or a \`sort\`), refused otherwise naming the fix. Over a bound block it joins what the iterations returned.

\`\`\`
roster = Text.join(sort(co-[t:Team]->.Name), ", ")
\`\`\`

### Text.chunks

\`Text.chunks(text, { size | entities, overlap })\` → a list of text, always present — cuts a long text into pieces. \`size\` bounds each piece by characters; \`entities\` instead sizes each piece by the records it is expected to yield, cutting on whole lines; exactly one of the two is written, and \`overlap\` (characters repeated from the piece before) works with either. \`unit:\` takes only \`"chars"\`.

\`\`\`
pieces = Text.chunks(text, { size: 40000, overlap: 2000 })
\`\`\`

### Text.regexExtract

\`Text.regexExtract(text, pattern, group?)\` → \`text\`, empty when nothing matches — the first regex match, or the first capture group when the pattern has one. The pattern reads whole characters (\`.\` matches an emoji) and is absent when malformed: escape only punctuation (\`\\\\.\`, \`\\\\-\`) or a known escape (\`\\\\d\`, \`\\\\s\`, \`\\\\x41\`, \`\\\\u{1F600}\`); an octal escape or an unknown letter escape is malformed.

\`\`\`
ref = Text.regexExtract(m.Subject, "(DEAL-\\\\d+)")
\`\`\`

### Text.slug

\`Text.slug(text)\` → \`text\`, always present — a lowercase-hyphen slug.

\`\`\`
slug = Text.slug("Acme Corp Ltd.")   # "acme-corp-ltd"
\`\`\`

### Text.pairs

\`Text.pairs(record, separator?)\` → \`text\`, always present — a record or a dict rendered as \`key=value\` pairs, keys in the order they were written (a dict literal's own order; a declared or extracted record's field order), joined by \`separator\` (default \`" | "\`). It takes a record from a walk or a name — \`Text.pairs(e)\` inside \`deduped-[e:entries]-> { … }\`, an extracted node, a \`first(…)\` answer — as well as a literal. Each value renders exactly as \`\${…}\` interpolation would: absent is empty, a boolean is \`true\`/\`false\`, a number is \`Text.from\`'s form. A nested node or edge field is SKIPPED, not stringified — only scalar fields make it into the line. Refused on \`<json>\`: it looks keyed but the checker cannot see its keys, so name the fields into a dict first.

Project A's composer posts one Slack line per candidate row:

\`\`\`
summary = Text.pairs({ name: c.Name, url: c.Website, stage: c.Stage })
# "name=Acme | url=acme.com | stage=Series A"
\`\`\`
\`\`\`
line = "candidate — \${Text.pairs({ name: c.Name, url: c.Website }, ", ")}"
# "candidate — name=Acme, url=acme.com"
\`\`\`

## Json

### Json.stringify

\`Json.stringify(value)\` → \`text\`, always present — any value written out as JSON text for a prompt, the same bytes every time it is the same value (so a prompt that opens with it stays cacheable). The JSON has two-space indent and keys sorted at every level, so the order you wrote fields in never shows. A record is its fields, plus one key per edge it carries holding the nodes on that edge as a list (always a list, even for one node). A dict, list or record inside the value is written out the same way. Absent is \`null\` (a record's absent field keeps its key; a whole absent value is the text \`null\`). Dates and datetimes are ISO text; a file is \`{ contentType, kind: "file", name, size }\`, never its contents. A record read live from a system is refused (build a dict of the fields you want).

\`\`\`
card = Json.stringify({ name: "Acme", stage: c.Stage })
# two lines of "name" and "stage", sorted, indented two spaces, inside braces
\`\`\`

## Number

### Number.abs

\`Number.abs(number)\` → \`number\`, the absolute value.

\`\`\`
diff = Number.abs(before - after)
\`\`\`

### Number.round

\`Number.round(number)\` → \`number\`, rounded to the nearest whole number (a half rounds away from zero: 2.5 is 3, -2.5 is -3).

\`\`\`
pct = Number.round(score * 100)
\`\`\`

### Number.floor

\`Number.floor(number)\` → \`number\`, rounded down.

\`\`\`
pages = Number.floor(Text.length(text) / 3000)
\`\`\`

### Number.ceil

\`Number.ceil(number)\` → \`number\`, rounded up.

\`\`\`
batches = Number.ceil(count(rows) / 50)
\`\`\`

### Number.parse

\`Number.parse(value)\` → \`number | absent\` — coerces text to a number, and is absent when the text is no number. Guard it (\`n != null\`) or give it a fallback (\`coalesce\`, \`?:\`) where a value is required. \`NUMBER(value)\` is its spelling inside walk brackets.

\`\`\`
n = Number.parse(msg.Subject) ?: 0
crm-[t:Teams WHERE t.\`Team Size\` <= NUMBER(m.Body)]->
\`\`\`

### Number.format

\`Number.format(number, style)\` → \`text | absent\` — a number written out. \`style\` is a literal, checked when you save: \`"compact"\` abbreviates with K/M/B/T, one decimal at most and no trailing \`.0\`; \`"grouped"\` adds thousands separators, keeping a decimal part up to two places.

\`\`\`
short = Number.format(1200000, "compact")   # "1.2M"
long  = Number.format(1200000, "grouped")   # "1,200,000"
\`\`\`

## Date

### Date.from

\`Date.from(value)\` → \`date\` — coerces any readable date or timestamp to a calendar day (midnight UTC). Reach for it when a comparison spans two kinds of value; \`DATE(value)\` is its spelling inside walk brackets.

\`\`\`
crm-[s:Tasks WHERE s.\`Snoozed Until\` <= DATE(m.Body)]->
\`\`\`

### Date.parse

\`Date.parse(text)\` → \`date | absent\` — a written date read as an ISO date; unreadable text (including an ambiguous numeric form like \`"12/03/2026"\`) is absent rather than a guess.

\`\`\`
d = Date.parse("12 March 2026")   # "2026-03-12"
\`\`\`

### Date.addDays

\`Date.addDays(date, days)\` → \`date\`, always present — a date shifted by whole days.

\`\`\`
deadline = Date.addDays(@current_date, 14)
\`\`\`

### Date.format

\`Date.format(value, pattern)\` → \`text\`, always present — a date written out for a person to read, from the tokens \`YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm m ss s\`; anything that is not a letter prints as written. The pattern is a literal, checked when you save.

\`\`\`
line = Date.format(@current_date, "MMMM D, YYYY")   # "August 31, 2026"
\`\`\`

### Date.today

\`Date.today(zone)\` → \`date\`, always present — the calendar date it is right now in a place, reading the run's pinned instant (not a live clock: every read in one run gives the same day). \`zone\` is a literal IANA name, checked when you save.

\`\`\`
today = Date.today("Europe/Berlin")
\`\`\`

## DateTime

### DateTime.from

\`DateTime.from(value)\` → \`datetime\` — coerces to a full UTC instant; \`DATETIME(value)\` is its spelling inside walk brackets.

\`\`\`
sent = DateTime.from(m.Date)
\`\`\`

### DateTime.at

\`DateTime.at(date, time, zone)\` → \`datetime\`, always present — the instant a wall-clock time on a date names in a place. \`time\` and \`zone\` are literals, checked when you save. Move days with \`Date.addDays\` and anchor each end of a window separately — a daylight-saving change then takes care of itself.

\`\`\`
win_end = DateTime.at(today, "07:00", "Europe/Berlin")
\`\`\`

### DateTime.toIso

\`DateTime.toIso(value)\` → any readable date or timestamp normalised to a full ISO 8601 UTC timestamp. A text with a time of day is read as ISO 8601 / RFC 3339 only (\`2026-03-05T10:00\`, \`2026-03-05 10:00:30+01:00\`); with no offset it is UTC.

\`\`\`
iso = DateTime.toIso(m.Date)
\`\`\`

## Currency

### Currency.numberFromFigure

\`Currency.numberFromFigure(figure)\` → \`number\`, always present (empty when unreadable) — the numeric amount in a money figure.

\`\`\`
amount = Currency.numberFromFigure("£1.2m")   # 1200000
\`\`\`

### Currency.codeFromFigure

\`Currency.codeFromFigure(figure)\` → \`text\` — the ISO currency code in a money figure.

\`\`\`
code = Currency.codeFromFigure("£1.2m")   # "GBP"
\`\`\`

### Currency.formatFigure

\`Currency.formatFigure(number, code)\` → \`text | absent\` — a number as a money figure, the inverse of \`Currency.numberFromFigure\`: a symbol where the code has one, the ISO code after a space where it doesn't, the bare number for an empty or unrecognised code. \`code\` may be any expression, not only a literal.

\`\`\`
line = Currency.formatFigure(1200000, "EUR")   # "€1.2M"
chf  = Currency.formatFigure(1200000, "CHF")   # "1.2M CHF"
\`\`\`

## Url

### Url.host

\`Url.host(text)\` → \`text | absent\` — the host, lowercased and otherwise verbatim (\`www.\` kept, no port, no path). Takes a full URL (\`https://acme.com\`) or a scheme-less address (\`acme.com\`, \`acme.com:8080\`, \`www.Acme.com/path\`) — the bare form is read as if \`http://\` were in front of it. Absent for an email (\`joe@acme.com\` names an account, not a host) and for text that names no address at all.

\`\`\`
host  = Url.host("https://WWW.Acme.com:8080/deals/1")   # "www.acme.com"
host2 = Url.host("acme.com")                             # "acme.com" — no scheme needed
\`\`\`

## List

### List.sum

\`List.sum(list of number)\` → \`number\`, always present, reads any order — the total. \`0\` over an empty list. A list that may hold an absent member is refused: \`List.compact\` it first.

\`\`\`
total = List.sum(co-[o:Orders]->.Amount)
\`\`\`

### List.avg

\`List.avg(list of number)\` → \`number\`, always present, reads any order — the mean.

\`\`\`
average = List.avg(co-[o:Orders]->.Amount)
\`\`\`

### List.min

\`List.min(list)\` → \`T | absent\`, reads any order — the smallest member; absent over an empty list. The element must be orderable (a number, date, datetime, or text).

\`\`\`
earliest = List.min(co-[o:Orders]->.\`Placed At\`)
\`\`\`

### List.max

\`List.max(list)\` → \`T | absent\`, reads any order — the largest member; absent over an empty list.

\`\`\`
biggest = List.max(co-[o:Orders]->.Amount)
\`\`\`

### List.last

\`List.last(list)\` → \`T | absent\` — the same ordering requirement as \`first\`, reading the other end.

\`\`\`
oldest = List.last(sort(co-[o:Orders]->.\`Placed At\`))
\`\`\`

### List.from

\`List.from(list | walk)\` → a list, always present (empty rather than absent), reads any order but keeps the source's order when it has one. Materialises a walk into an ordinary list value — the form to reach for when a later fold (\`Text.join\`, \`first\`, \`xs[n]\`) needs one and the walk itself has none to give.

\`\`\`
names = List.from(co-[p:People]->.Name)
\`\`\`

### List.compact

\`List.compact(a, b, c, …)\` → a flat list of the arguments with nulls dropped, always present. A list argument flattens one level in, so \`List.compact\` is the way to combine several possibly-empty values (or lists of them) into one list.

\`\`\`
Tags: List.compact("inbound", region, [\`Sub Tag\`])
\`\`\`

### List.groupBy

\`List.groupBy(list, key)\` → a dict of lists, always present — files each member under the key its function answers. The values carry the members' own shape (a dict literal's fields read straight off a group); the keys are data, so a lookup with \`by[key]\` is always \`T | absent\` even against a literal string.

\`\`\`
by = List.groupBy(rows, (r) => { return r.thesis })
\`\`\`

### List.keyBy

\`List.keyBy(list, key)\` → a dict of members, one per key, always present — a repeated key fails the run, naming it. Same shape-carrying and key-lookup rules as \`List.groupBy\`.

\`\`\`
byId = List.keyBy(co-[p:People]->, (p) => { return p.Email })
\`\`\`

## File

### File.from

\`File.from(content, "pdf" | "text")\` → a \`file\` value, always present — turns a composed string into a file for a file-typed field. \`type\` is a literal; the content renders as plain text, line breaks preserved.

\`\`\`
File: File.from(digest, "pdf")
\`\`\`

### File.read

\`File.read(file)\` → \`text | absent\` — the text in a file. An extraction reads a file in its content itself; reach for \`File.read\` when you want the text in hand to cut, measure, or pass to a plugin.

\`\`\`
text = File.read(f.File)
\`\`\`
`,
  engineClaims: [
    {
      construct: 'text and number helpers (Text.trim/lower/upper/length/split/concat/from, Number.abs/round/floor/ceil/parse, List.compact, == null)',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

function \`Intake\`(m: <inbox-[:Email]->>) {
  n    = Number.parse(m.Subject)
  tags = List.compact("inbound", Text.split(m.Subject, ";"))
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        Text.upper(Text.trim(m.Subject))
    Description: Text.concat(Text.lower(m.From), " — ", Text.from(Number.abs(Number.round(1.6))), "/", Text.from(Number.floor(1.6)), "/", Text.from(Number.ceil(1.6)), " — ", Text.from(count(tags)))
    \`Team Size\` ?: n
  }
  big = Text.length(m.Body) > 500
  if (n == null) { fail("no number in the subject") }
}
`,
    },
    {
      construct: 'coalesce and exists (including a walk WHERE form)',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

function \`Intake\`(m: <inbox-[:Email]->>) {
  if (exists(m-[a:Attachments WHERE a.Name CONTAINS "pdf"]->)) {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: coalesce(m.From, "unknown")
    }
  }
}
`,
    },
    {
      construct: 'the commutative aggregates (count, only) over a captured relationship, plus Text.join/first/List.last/xs[n] each ordered inline with sort',
      status: 'runs',
      probe: `
import { \`@lf/attio\` as attio } from adapters
import { acme } from credentials

crm = connect attio using acme

function m(evt: <crm-[e:\`Webhook Event\` WHERE e.action == "record.created"]->>) {
  evt-[co:Companies]-> {
    names = co-[p:Team]-> { return p.Name }
    n     = count(co-[p:Team]->)
    owner = only(co-[t:Team WHERE t.\`Job Title\` == "CEO"]->)
    newest = first(sort(names))
    oldest = List.last(sort(names))
    head   = sort(names)[0]
    write co {
      Description: "\${n} people, \${Text.join(sort(names), ", ")}, \${coalesce(owner.Name, "no CEO")}, \${coalesce(newest, "")}/\${coalesce(oldest, "")}/\${coalesce(head, "")}"
    }
  }
}
`,
    },
    {
      construct: 'List.sum/avg/min/max over a list of numbers',
      status: 'runs',
      probe: `
import { \`@lf/attio\` as attio } from adapters
import { acme } from credentials

crm = connect attio using acme

function m(evt: <crm-[e:\`Webhook Event\` WHERE e.action == "record.created"]->>) {
  evt-[co:Companies]-> {
    amounts = [1200, 400, 900]
    total   = List.sum(amounts)
    average = List.avg(amounts)
    lowest  = List.min(amounts)
    highest = List.max(amounts)
    write co {
      \`Team Size\` ?: total
      Description: "\${average}/\${coalesce(Text.from(lowest), "")}/\${coalesce(Text.from(highest), "")}"
    }
  }
}
`,
    },
    {
      construct: 'map/filter/reduce/List.groupBy/List.keyBy, a bare no-return map statement, and indexing a dict literal vs a List.groupBy result',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

function \`Roster\`(go: <runs-[:Invocation]->>) {
  d = { bucket: "a", packed: 3 }
  lead = d.bucket

  rows   = crm-[p:People ORDER BY p.Name]-> { return { name: p.Name, title: p.\`Job Title\` } }
  lines  = map(rows, (r) => { return r.name })
  kept   = filter(lines, (t) => { return Text.length(t) > 0 })
  total  = reduce(kept, (carried, t) => { return carried + Text.length(t) }, 0)
  by     = List.groupBy(rows, (r) => { return r.title })
  byName = List.keyBy(rows, (r) => { return r.name })
  own    = byName["founder@acme.com"]
  ceos   = by.CEO

  map(rows, (r) => {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: r.name
    }
  })

  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        lead
    Description: "\${Text.join(kept, ", ")} (\${total} chars, has a founder entry: \${(own != null)}, groups: \${(ceos != null)})"
  }
}

listen to runs {} fire \`Roster\`
`,
    },
    {
      construct: 'members in declaration order, the c ? a : b conditional, and unary minus',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/slack\` as slack } from adapters
import { team_workspace } from credentials

runs = connect manual
chat = connect slack using team_workspace

type Thesis = <"Consumer" | "Infra" | "Health">

function \`Recap\`(go: <runs-[:Invocation]->>) {
  theses = members(<Thesis>)
  before = 10
  after  = 4
  delta  = -(after - before)
  lead   = theses[0]
  line   = lead != null ? "\${lead}" : ""

  ops = only(chat-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  write ops-[:Messages]-> { Message: "\${Text.join(theses, ", ")} / \${line} / \${delta}" }
}

listen to runs {} fire \`Recap\`
`,
    },
    {
      construct: 'File.from/File.read/Text.chunks and the coercers Date.from/DateTime.from/Number.parse',
      status: 'runs',
      probe: `
import { \`@lf/manual\` as manual, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

runs = connect manual
crm  = connect attio using acme

function \`Cut A Document\`(go: <runs-[:Invocation]->>) {
  go-[f:Files]-> {
    text   = File.read(f.File)
    pieces = Text.chunks(coalesce(text, ""), { size: 40000, overlap: 2000 })
    company = write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:          coalesce(first(pieces), "untitled")
      \`Team Size\` ?: Number.parse(coalesce(first(pieces), ""))
    }
    write company-[:Files]-> {
      File: File.from(Text.join(pieces, "\\n"), "pdf")
    }
    write company-[:Notes]-> {
      Title:   "Window"
      Content: "\${Date.from(@current_date)} / \${DateTime.from(@current_date)}"
    }
  }
}

listen to runs {} fire \`Cut A Document\`
`,
    },
    {
      construct: 'namespace members: Currency.*, Date.*, DateTime.at/toIso, Text.regexExtract/slug, Url.host, Number.format',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

function \`Intake\`(m: <inbox-[:Email]->>) {
  today  = Date.today("Europe/Berlin")
  win    = DateTime.at(today, "07:00", "Europe/Berlin")
  ref    = Text.regexExtract(m.Subject, "(DEAL-\\\\d+)")
  amount = Currency.numberFromFigure(m.Body)
  company = write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        Text.slug(m.Subject)
    Description: Currency.codeFromFigure(m.Body)
    \`Team Size\` ?: amount
  }
  write company-[:Notes]-> {
    Title:   "Window"
    Content: "\${coalesce(Date.parse(m.Subject), Date.addDays(today, 7))} / \${Date.format(today, "MMMM D, YYYY")} / \${DateTime.toIso(win)} / \${coalesce(ref, "")} / \${coalesce(Url.host(m.Body), "")} / \${coalesce(Number.format(amount, "compact"), "")} / \${coalesce(Currency.formatFigure(amount, "EUR"), "")}"
  }
}
`,
    },
  ],
};
