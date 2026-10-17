// How a new-store ask record projects onto the on-system answer surfaces (the
// "your asks" control tower, the agent's MCP list, the link page). ONE mapping
// from an ask FAMILY to the control an author-facing surface renders, plus the
// per-family option / editable-record shapes those controls consume. Kept
// dependency-light (only the store's own types) so every surface — web tRPC,
// MCP REST, the public link route — can import it without dragging the whole
// adapter graph or the legacy interaction service in.
//
// The family IS the answer's type (3_adapter_contract §B), so the control a
// surface shows is a pure function of the family — there is no runtime
// disagreement possible between what the person sees and what the store keeps.

import type { AskFamily, AskRecord } from './store';

import { neverAsAny } from 'movement-engine/public/utils';

/** The control-kind each family renders as, in the vocabulary the shared
 *  link-page + web controls already switch on (Check → yes/no, Choose → one
 *  button per option, Select → a checklist, Provide → a typed input, Correct →
 *  editable record cards, Review → acknowledge, Form → a field per name, Draft →
 *  the app editor). Jargon-free: never "adapter"/"position"/"family" in any
 *  string a person sees — this map is internal control-selection only. */
export const FAMILY_TO_INTERACTION: Record<AskFamily, string> = {
  Check: 'check',
  Provide: 'provide',
  Choose: 'choose',
  Select: 'select',
  Review: 'review',
  Correct: 'correct',
  Draft: 'draft',
  Form: 'form',
};

/** Choose/Select offer their choices, Form names the fields it collects — all
 *  ride the ask's `options` column and render from an option list. */
const OPTIONS_FAMILIES = new Set<AskFamily>(['Choose', 'Select', 'Form']);

export function askInteractionType(ask: AskRecord): string {
  return FAMILY_TO_INTERACTION[ask.family];
}

/** One offered option, in the `{ id, label, value }` shape the checklist /
 *  button controls consume. */
export interface AskViewOption {
  id: string;
  label: string;
  value: unknown;
}

/** The offered options for a Choose/Select/Form ask; undefined for families
 *  that offer none (so a surface renders a typed input / yes-no instead). */
export function askViewOptions(ask: AskRecord): AskViewOption[] | undefined {
  if (!OPTIONS_FAMILIES.has(ask.family)) return undefined;
  return (ask.options ?? []).map((o) => ({ id: o, label: o, value: o }));
}

/** One editable record offered to a Correct ask, plus a display label. */
export interface AskViewCorrectRow {
  ephemeralId: string;
  fields: Record<string, unknown>;
  label: string;
}

export interface AskViewCorrect {
  columns: string[];
  rows: AskViewCorrectRow[];
}

/** The editable records + derived columns for a Correct ask; undefined for
 *  every other family. Columns are the union of the rows' field keys in
 *  first-seen order — the same derivation the legacy control tower uses. */
export function askViewCorrect(ask: AskRecord): AskViewCorrect | undefined {
  if (ask.family !== 'Correct' || !ask.rows) return undefined;
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: AskViewCorrectRow[] = [];
  for (const row of ask.rows) {
    for (const key of Object.keys(row.fields)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
    rows.push({ ephemeralId: row.ephemeralId, fields: row.fields, label: correctRowLabel(row.fields) });
  }
  return { columns, rows };
}

function correctRowLabel(fields: Record<string, unknown>): string {
  for (const key of ['name', 'Name', 'label', 'Label', 'title', 'Title']) {
    const v = fields[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  for (const v of Object.values(fields)) {
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** The answer's result type, per FAMILY — the family IS the answer's type
 *  (3_adapter_contract §B), so the advertised type is a pure function of it.
 *  Mirrors the legacy `interaction_request.result_type` (`{ graph, position? }`,
 *  the engine's `serializeTypeRef` output) the answer surfaces + `validateAnswer`
 *  read: `boolean` / `number` / `text` are recognised scalars; the list and
 *  structured shapes are advertised honestly and validated by the family's own
 *  `coerceAnswer` (the interaction control drives their answer shape).
 *
 *  This used to return `{ graph: ask.answerType ?? 'string' }` for EVERY family
 *  — but only `Provide` populates `answerType`, so six of seven families lied
 *  `string` (a Check advertised `string` over /v1/automation/reviews). Silent
 *  degradation is the absence of a guarantee — each family now advertises the
 *  type its answer actually has. */
export function askResultType(ask: AskRecord): { graph: string; position?: string } {
  switch (ask.family) {
    case 'Check':
      return { graph: 'boolean' };
    case 'Choose':
      // Exactly one of the offered options (which ride `args.options`).
      return { graph: 'string' };
    case 'Select':
      // A subset of the offered options — the answer is a LIST of strings.
      return { graph: 'list of string' };
    case 'Review':
      // Awareness only — the answer is an acknowledgement string ('ack').
      return { graph: 'string' };
    case 'Provide':
      // The author-declared answer type; `coerceProvide` treats a missing one as
      // free text, so advertise `text` to match.
      return { graph: ask.answerType ?? 'text' };
    case 'Correct':
      // The edited records — a structured `{ rows, dropped }` object.
      return { graph: 'record' };
    case 'Draft':
      // A structured object the person composed.
      return { graph: 'record' };
    case 'Form':
      // One object with a value for each named field.
      return { graph: 'record' };
    default:
      return neverAsAny(ask.family);
  }
}
