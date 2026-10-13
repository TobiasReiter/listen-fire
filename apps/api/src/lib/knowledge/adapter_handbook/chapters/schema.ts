import type { Chapter } from '../types';

export const schema: Chapter = {
  id: 'schema',
  title: 'Describing your data model',
  content: `## Describing your data model

Two methods tell Listen-Fire the shape of your data: \`listEntryPoints\` (the
types Listen-Fire can start from) and \`describe\` (one type's full shape).
These are where builders most often go wrong — get the shapes exactly
right.

### listEntryPoints

Returns the types Listen-Fire can start from:
\`\`\`json
[
  { "typeId": "Company", "displayName": "Company", "writable": true, "readable": true }
]
\`\`\`
- \`writable: true\` → Listen-Fire may create this type. \`readable: true\` →
  Listen-Fire may read from and traverse from it. Set them to match what your
  methods actually support — a write-only sink marks its types
  \`readable: false\`, a read-only source marks them \`writable:
  false\`.

### describe(typeId)

Returns one type's full shape, or \`null\` if the \`typeId\` is unknown:
\`\`\`json
{
  "typeId": "Company",
  "displayName": "Company",
  "fields": [
    { "fieldId": "Name", "displayName": "Name", "kind": "string", "writable": true, "required": true },
    { "fieldId": "Stage", "displayName": "Stage", "kind": "string", "writable": true, "required": false }
  ],
  "references": []
}
\`\`\`
- Use the **same string** for \`fieldId\` and \`displayName\` unless
  your system needs an internal id distinct from the human name — Listen-Fire
  writes \`fields\` keyed by \`displayName\`, so keeping them equal makes
  the mapping the identity.
- \`kind\` is one of \`string\`, \`number\`, \`boolean\`, \`date\`,
  \`file\`, \`json\`, \`enum\` (list the options in \`enumValues\`) or
  \`reference\`. Any other kind is silently dropped and leaves the type
  unchecked — automations may then read any field name off it. Add
  \`"cardinality": "many"\` for a list. \`writable\` / \`required\`
  gate authoring.
- A field that only means something on a write — send-side media, a
  one-shot payload your system never stores — marks itself
  \`"readable": false\` (absent means readable). It stays writable;
  Listen-Fire then rejects reads of it when the automation is authored,
  instead of silently returning nothing at run time.
- \`references\` are edges to other types (each at least
  \`{ "fieldId": "..." }\`); leave \`[]\` if your type has none.
- References take the same pair, with different defaults:
  \`readable\` defaults to true, and \`"readable": false\` marks a pure
  create path with nothing to read behind it (a reply thread your system
  can't list); \`writable\` is only true when you say \`"writable": true\`
  — leave it out for an edge your system fills itself (a message's inbound
  attachments — nothing can ever be created along it). Read and write
  surfaces are allowed to be asymmetric — describe what each direction
  honestly supports rather than forcing one shape on both.
- \`"deletable": true\` on a type says your \`deleteRecord\` removes a
  record of it. Absent means no: an automation's \`delete x\` of that
  type is refused while it is authored (language version 5 on), rather
  than failing when it runs. Declare it type by type — a CRM that deletes
  companies but not their notes says so on Company only.

### Keeping the two in sync

Every \`typeId\` you return from \`listEntryPoints\` must resolve to a
descriptor when Listen-Fire calls \`describe\` on it, and every type your write
and read methods touch should be reachable from an entry point. Treat
the descriptor as the contract: the field names you list here are exactly
the keys Listen-Fire sends in write input and asks for in \`getFieldValue\`.

### When a create has two shapes (optional)

Some types can be created in more than one way, and no field says which.
A chat message is the everyday case: text with a file, or text with a
rich layout — never both, and nothing in the body labels the choice.
Declare that with \`writeUnion\`, naming each shape by the fields it
accepts:

\`\`\`json
"writeUnion": {
  "variants": [
    { "name": "a file post", "fields": ["text", "file"] },
    { "name": "an interactive post", "fields": ["text", "blocks"] }
  ]
}
\`\`\`

A write body must fit at least one variant. Listen-Fire refuses one that fits
none while the automation is authored, and its error offers the author
the shapes to choose between — which is the whole job of \`name\`. Two
rules keep the list from lying about your surface:

- **at least two variants** — one variant is not a union, it is just the
  type's shape;
- **every writable field appears in some variant** — a field named in
  none would be advertised as writable and then rejected by every body
  that set it.

\`fields\` are \`fieldId\`s, not display names. Reach for this when your
create endpoint really is two endpoints; if a literal field DOES select
the shape, that is \`discriminatedWrite\` instead, and declaring both is
an error — nothing would decide which one picks the variant.

### When your types are nested (optional)

Most systems are flat: every Company has the same fields, so \`Company\`
is ONE type no matter how many records sit behind it. The two methods
above are all you need, and you can stop reading here.

Some systems aren't. Ask one question:

> Do all the things at this level have the SAME shape?

If two containers hold different fields — two Airtable bases hold
different tables, two workspaces hold different object types — then they
are not two records of one type. **They are two types.** Listing every
type inside every container up front is then a call per container, which
is what makes a big workspace time out and return nothing.

Implement \`edgesFrom\` instead and Listen-Fire walks in one hop at a time:
the root's types, then one container's types, then a type's fields. Add
\`"edgesFrom"\` to your manifest's \`methods\` to advertise it; leave it
out and Listen-Fire just calls \`describe\`, which stays correct.

\`\`\`
edgesFrom(position, cursor?) -> { descriptor, targetPositions?, nextCursor? } | null
\`\`\`

A **position is a path**: everything you need to get back to that node.
Listen-Fire never builds one — you hand them out, it hands them back. The walk
starts at the root, whose position is \`{ "recordType": "meta" }\`:

\`\`\`json
{
  "descriptor": {
    "typeId": "meta", "displayName": "meta", "fields": [],
    "references": [
      { "fieldId": "base-1", "name": "Sales CRM", "targetTypeId": "Sales CRM", "cardinality": "many" }
    ]
  },
  "targetPositions": {
    "base-1": {
      "adapterType": "my-adapter", "recordType": "Base",
      "identity": { "kind": "stable", "recordId": "app123", "data": { "name": "Sales CRM" } }
    }
  }
}
\`\`\`

Listen-Fire hands \`targetPositions["base-1"]\` straight back to reach that
base, and your \`edgesFrom\` gets \`app123\` without looking anything up.
That is the whole point: **put in the position whatever you'd otherwise
have to go searching for.** A table inside a base carries its base's id
too, because a table can't be found without one.

Three rules that save pain:

- **\`targetPositions\` is keyed by the edge's \`fieldId\`** — that's how
  Listen-Fire matches a path to the edge it belongs to.
- **Use your OWN words for \`recordType\` in a position** (\`Base\`,
  \`Table\`) — not the type's published name. These name a place in your
  schema, not a record; keeping them distinct means a container can never
  be mistaken for a record inside it. The name Listen-Fire shows the user stays
  \`targetTypeId\`.
- **Page a wide hop** with \`nextCursor\` (any value you like — Listen-Fire
  sends it back as \`cursor\`). Ten thousand containers is one hop
  otherwise.

Keep \`describe\` working by name: it is what answers when Listen-Fire has a
name but no path to it. And give the author a way IN — a construction arg
that starts the instance inside one container (see \`authoringHints\`),
since a type nested inside one can't be named from the root.

Your manifest can also declare a \`handbookSection\` — a title and a body of
prose about your system's idioms, which Listen-Fire assembles into the authoring
handbook as its own chapter. Field and edge descriptions teach at the point
of use; a section is where you say what somebody should understand about
your system *before* they start building against it.`,
};
