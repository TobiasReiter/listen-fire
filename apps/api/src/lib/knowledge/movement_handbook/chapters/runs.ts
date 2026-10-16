import type { Chapter } from '../types';

export const runs: Chapter = {
  id: 'runs',
  title: 'Runs — reading what an automation did',
  content: `## Runs — reading what an automation did

Every firing of an automation — a live event arriving, a "run now" backfill, a dry-run rehearsal — is recorded as a **run**: one entry in the automation's history holding what the automation wrote, where, and why — the surface for verifying it does what the text says, and for tracing any written value back to its source.

### run-history

Each listener keeps its own history, and an unchanged \`listen\` keeps its history across saves (retiring a listener orphans its history rather than deleting it — the record of what ran outlives the line that ran it). A run records, in program order, every write the firing performed:

- the target system and record type, and what the write did — **created** the record, **updated** it (at least one field was sent), **attached** it to its parent (a matched record whose own fields were all unchanged, hung off the parent the write names — the target system confirmed the attachment, so \`attach\` means the relationship is there), or **noop** (a matched record with nothing to send at all). Duplicate prevention is visible as "updated" where you expected "created";
- the written record's id in the target (and a link, where the target provides one);
- the **values actually sent** — after no-change suppression, so an update that found nothing new shows an empty write rather than a phantom one;
- the record's **linkage** — for a linked or tuple write, the parent record(s) it hangs off and the connecting edge, and whether the target **made** the association on this run or found it **already** there. This is how you verify the cardinal rule from the record of a run: every write that should be attached shows *what* it attached to. A system that cannot attach an existing record along the edge you wrote fails the run and says so, rather than reporting a relationship nobody made;
- standalone \`link\` / \`unlink\` / \`delete\` entries, carrying the asserted or severed edge (or the removed record) with the same provenance as writes;
- the run's **decision trace** — the gates it evaluated on the way (an \`if\` over an \`ai\` judgement records the prompt and the outcome), so "why did this run proceed at all" is answerable from the record;
- for rehearsals (instances connected with \`{ dryRun: true }\`), the writes that *would* have been sent, captured instead of committed — same shape, nothing applied.

### provenance

Every written field also carries its **provenance** — where that exact value came from:

- **a field of the triggering event or a traversed record** — which system, which record, which field;
- **an extraction** — which entity the model pulled out, the field's authored description, and the model's verbatim supporting quote from the source data;
- **an earlier write in the same run** — quoting a handle (\`"record \${company.externalId}"\`) chains the new value to that write, whose own fields carry their own trails: provenance follows data across systems;
- **an \`ai\` call** — the instruction it was given;
- **a literal in the automation text** — the value was authored, not derived.

A value combined from several sources (an interpolated message, say) lists every source that influenced it. A value that arrived *untouched* from an extraction keeps its verbatim quote — that is what makes a written fact citable back to the exact sentence it came from; a transformed value keeps its sources but drops the quote, because the quote would no longer justify it.

### failures

A failed firing is recorded too, with the reason named — a missing required field, a construct the engine can't execute yet, a target that refused the write. The run history is therefore also the debugging surface: the failure sits next to the event that caused it, and the fix is a text edit plus the next event (or a "run now").

### what-a-run-costs

A run's cost is the language-model work inside it: an \`ai\` call on the default tier is far cheaper than one asking for \`"thorough"\`, and a large \`extract\` is the most expensive shape there is (its chapter covers why — and it takes the same tier, which is the biggest lever there is on what one costs). Time a run spends paused (waiting for a person at an \`ask\`) or asleep costs nothing, so a long approval wait or a scheduled delay is free.

### Pitfalls

- **Verifying from the target system only.** The run shows what was sent and why; the target shows only the end state. When a field looks wrong, read its provenance before editing the automation.
- **Expecting a quote on transformed values.** Only a value written untouched from its source keeps the verbatim quote; anything combined or rewritten lists its sources without claiming the quote still holds.
- **Treating an empty update as a bug.** A run that matched an existing record and found every field unchanged sends no fields — that is duplicate prevention working, not a failure. It reads as **attach** when the write hangs off a parent (the target confirmed the association) and **noop** when it does not.`,
};
