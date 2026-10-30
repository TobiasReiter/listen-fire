"use client";

/**
 * Shared per-kind ask controls — the answer surface for a parked `ask`, rendered
 * identically on both the login-less capability link (`/a/[token]`) and the
 * in-app control tower (`/asks`). One implementation, two consumers:
 *
 *   - Provide  → a typed input (number / date / text) keyed off the result type,
 *     or Yes/No buttons when the result type is boolean (no free-text form makes
 *     sense there)
 *   - Select   → a checklist; the chosen subset is the answer
 *   - Correct  → editable record cards: edit each field, Keep/Remove per record
 *   - Check    → Yes / No
 *   - Choose / Pick → a button per option
 *   - Review / Notify → a single acknowledge
 *   - Draft    → a clear placeholder (the rich editor is a later chunk)
 *
 * Each control calls `onSubmit(answer, recordedLabel)` with the SAME structured
 * payload the engine's `validateAnswer` expects (a boolean for Check, the chosen
 * ids for Select, `{ rows, dropped }` for Correct, …) — no per-surface forking.
 *
 * `variant` adapts the chrome, not the payload:
 *   - "page"   → the standalone link page renders the question heading + roomy
 *     spacing (the responder may have no other context).
 *   - "inline" → the control tower already shows the question in the row; the
 *     control renders just the input area, compact, to sit under the ask row.
 */

import { useState } from "react";

import { Button, buttonClass } from "@/components/ui";

export interface AskOption {
  id: string;
  label: string;
  /** The durable answer payload; the controls submit option ids, so the value is
   *  display-irrelevant here (the engine validates ids → values server-side). */
  value?: unknown;
}

export interface AskCorrectRow {
  ephemeralId: string;
  fields: Record<string, unknown>;
  label: string;
}

export interface AskCorrect {
  columns: string[];
  rows: AskCorrectRow[];
}

/** The per-kind ask content a control needs to render + submit. Both surfaces
 *  project their feed into this shape (the link page from `GET …/detail`, the
 *  control tower from the `listOpenAsks` summary). */
export interface AskControlData {
  interactionType: string;
  resultType: { graph: string; position?: string };
  title: string;
  detail?: string;
  options?: AskOption[] | null;
  correct?: AskCorrect | null;
}

export type AskControlVariant = "page" | "inline";

interface ControlProps {
  ask: AskControlData;
  submitting: boolean;
  variant: AskControlVariant;
  onSubmit: (answer: unknown, recordedLabel: string) => void;
}

/** Dispatch to the control matched to the ask's interaction type. The single
 *  entry point both surfaces render. */
export function AskControl(props: ControlProps) {
  const kind = props.ask.interactionType.toLowerCase();
  if (kind === "provide") return <ProvideControl {...props} />;
  if (kind === "select") return <SelectControl {...props} />;
  if (kind === "check") return <CheckControl {...props} />;
  if (kind === "review" || kind === "notify") return <AcknowledgeControl {...props} />;
  if (kind === "choose" || kind === "pick") return <ChooseControl {...props} />;
  if (kind === "correct") return <CorrectControl {...props} />;
  return <DraftControl {...props} />;
}

// ─── Heading (page variant only) ─────────────────────────────────────────────

function AskHeading({ ask, variant }: { ask: AskControlData; variant: AskControlVariant }) {
  if (variant !== "page") return null;
  return (
    <div className="mb-5">
      <h1 className="text-[17px] font-semibold leading-snug text-gray-900">
        {ask.title}
      </h1>
      {ask.detail && (
        <p className="mt-2 text-[13px] leading-relaxed text-gray-500">
          {ask.detail}
        </p>
      )}
    </div>
  );
}

// ─── Provide<S> — a typed input matched to the result type ───────────────────

function ProvideControl(props: ControlProps) {
  if (props.ask.resultType.graph === "boolean") return <ProvideBooleanControl {...props} />;
  return <ProvideTextControl {...props} />;
}

/** Provide<boolean> — same Yes/No pattern as Check, since a boolean result type
 *  has no meaningful free-text form for a responder to type. */
function ProvideBooleanControl({ ask, submitting, variant, onSubmit }: ControlProps) {
  return (
    <div>
      <AskHeading ask={ask} variant={variant} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={submitting}
          onClick={() => onSubmit(true, "Yes")}
        >
          Yes
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={submitting}
          onClick={() => onSubmit(false, "No")}
        >
          No
        </Button>
      </div>
    </div>
  );
}

function ProvideTextControl({ ask, submitting, variant, onSubmit }: ControlProps) {
  const graph = ask.resultType.graph;
  const inputType = graph === "number" ? "number" : graph === "date" ? "date" : "text";
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const valid = trimmed !== "" && (inputType !== "number" || Number.isFinite(Number(trimmed)));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || submitting) return;
        const answer = inputType === "number" ? Number(trimmed) : trimmed;
        onSubmit(answer, trimmed);
      }}
    >
      <AskHeading ask={ask} variant={variant} />
      <input
        autoFocus={variant === "page"}
        type={inputType}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={inputType === "number" ? "Enter a number" : inputType === "date" ? "" : "Type your answer"}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[14px] text-gray-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      <div className="mt-3 flex justify-end">
        <Button type="submit" variant="primary" size="sm" disabled={!valid || submitting}>
          {submitting ? "Saving…" : "Submit"}
        </Button>
      </div>
    </form>
  );
}

// ─── Select<T> — a checklist; the chosen subset is the answer ────────────────

function SelectControl({ ask, submitting, variant, onSubmit }: ControlProps) {
  const options = ask.options ?? [];
  const [checked, setChecked] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (options.length === 0) {
    return (
      <div>
        <AskHeading ask={ask} variant={variant} />
        <p className="text-[13px] text-gray-500">There’s nothing to choose from here.</p>
      </div>
    );
  }

  const chosenLabels = options.filter((o) => checked.has(o.id)).map((o) => o.label);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting) return;
        const ids = options.filter((o) => checked.has(o.id)).map((o) => o.id);
        onSubmit(
          ids,
          chosenLabels.length > 0 ? chosenLabels.join(", ") : "nothing selected",
        );
      }}
    >
      <AskHeading ask={ask} variant={variant} />
      <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100">
        {options.map((opt) => {
          const isChecked = checked.has(opt.id);
          return (
            <label
              key={opt.id}
              className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={() => toggle(opt.id)}
                className="h-4 w-4 accent-primary"
              />
              <span className="text-[14px] text-gray-900">{opt.label}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12px] text-gray-400">{checked.size} selected</span>
        <Button type="submit" variant="primary" size="sm" disabled={submitting}>
          {submitting ? "Saving…" : "Submit selection"}
        </Button>
      </div>
    </form>
  );
}

// ─── Check<boolean> — two buttons ────────────────────────────────────────────

function CheckControl({ ask, submitting, variant, onSubmit }: ControlProps) {
  return (
    <div>
      <AskHeading ask={ask} variant={variant} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={submitting}
          onClick={() => onSubmit(true, "Yes")}
        >
          Yes
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={submitting}
          onClick={() => onSubmit(false, "No")}
        >
          No
        </Button>
      </div>
    </div>
  );
}

// ─── Choose / Pick — a button per option ─────────────────────────────────────

function ChooseControl({ ask, submitting, variant, onSubmit }: ControlProps) {
  const options = ask.options ?? [];
  if (options.length === 0) {
    return (
      <div>
        <AskHeading ask={ask} variant={variant} />
        <p className="text-[13px] text-gray-500">
          Use the options in the message you received to respond.
        </p>
      </div>
    );
  }
  return (
    <div>
      <AskHeading ask={ask} variant={variant} />
      <div className="flex flex-col gap-2">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={submitting}
            onClick={() => onSubmit(opt.id, opt.label)}
            className={`${buttonClass({ variant: "secondary", size: "sm" })} justify-start`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Correct — editable record cards; edit fields, remove records ────────────

/** Render a field value as the string the input shows. Objects/arrays stringify
 *  (rare for editable columns); null/undefined → empty. */
function fieldToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Coerce an edited cell's text back toward the original value's type — a number
 *  field stays numeric, everything else is text. Keeps the submitted value shaped
 *  like what the record held. */
function textToField(text: string, original: unknown): unknown {
  if (typeof original === "number" && text.trim() !== "" && Number.isFinite(Number(text))) {
    return Number(text);
  }
  return text;
}

function CorrectControl({ ask, submitting, variant, onSubmit }: ControlProps) {
  const correct = ask.correct ?? { columns: [], rows: [] };
  // Per-row, per-column edited text. Seeded lazily from the record's values.
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  function cellText(row: AskCorrectRow, column: string): string {
    const rowEdits = edits[row.ephemeralId];
    if (rowEdits && column in rowEdits) return rowEdits[column];
    return fieldToText(row.fields[column]);
  }

  function setCell(rowId: string, column: string, text: string) {
    setEdits((prev) => ({
      ...prev,
      [rowId]: { ...(prev[rowId] ?? {}), [column]: text },
    }));
  }

  function toggleRemoved(rowId: string) {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  if (correct.rows.length === 0) {
    return (
      <div>
        <AskHeading ask={ask} variant={variant} />
        <p className="text-[13px] text-gray-500">There’s nothing to review here.</p>
      </div>
    );
  }

  const keptCount = correct.rows.filter((r) => !removed.has(r.ephemeralId)).length;

  function handleSubmit() {
    if (submitting) return;
    const rows = correct.rows
      .filter((r) => !removed.has(r.ephemeralId))
      .map((r) => {
        const fields: Record<string, unknown> = {};
        const rowEdits = edits[r.ephemeralId] ?? {};
        for (const column of Object.keys(rowEdits)) {
          fields[column] = textToField(rowEdits[column], r.fields[column]);
        }
        return { ephemeralId: r.ephemeralId, fields };
      });
    const dropped = correct.rows
      .filter((r) => removed.has(r.ephemeralId))
      .map((r) => r.ephemeralId);
    onSubmit({ rows, dropped }, `${keptCount} record${keptCount === 1 ? "" : "s"}`);
  }

  return (
    <div>
      <AskHeading ask={ask} variant={variant} />
      <div className="flex flex-col gap-3">
        {correct.rows.map((row) => {
          const isRemoved = removed.has(row.ephemeralId);
          return (
            <div
              key={row.ephemeralId}
              className={`rounded-xl border px-4 py-3 transition-colors ${
                isRemoved ? "border-gray-100 bg-gray-50" : "border-gray-200 bg-white"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span
                  className={`truncate text-[13px] font-medium ${
                    isRemoved ? "text-gray-400 line-through" : "text-gray-900"
                  }`}
                >
                  {row.label || "Record"}
                </span>
                <button
                  type="button"
                  onClick={() => toggleRemoved(row.ephemeralId)}
                  className="shrink-0 text-[12px] font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
                >
                  {isRemoved ? "Keep" : "Remove"}
                </button>
              </div>
              {!isRemoved && (
                <div className="flex flex-col gap-2.5">
                  {correct.columns.map((column) => (
                    <label key={column} className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                        {column}
                      </span>
                      <input
                        type="text"
                        value={cellText(row, column)}
                        onChange={(e) => setCell(row.ephemeralId, column, e.target.value)}
                        className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-[14px] text-gray-900 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12px] text-gray-400">
          {keptCount} of {correct.rows.length} kept
        </span>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={submitting}
          onClick={handleSubmit}
        >
          {submitting ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ─── Review / Notify — a single acknowledge ──────────────────────────────────

function AcknowledgeControl({ ask, submitting, variant, onSubmit }: ControlProps) {
  return (
    <div>
      <AskHeading ask={ask} variant={variant} />
      <Button
        variant="primary"
        size="sm"
        disabled={submitting}
        onClick={() => onSubmit("ack", "Acknowledged")}
      >
        Got it
      </Button>
    </div>
  );
}

// ─── Draft — the rich editor is a later chunk ────────────────────────────────

function DraftControl({ ask, variant }: ControlProps) {
  return (
    <div>
      <AskHeading ask={ask} variant={variant} />
      <p className="rounded-lg bg-amber-50 px-3 py-2.5 text-[13px] leading-relaxed text-amber-800">
        This response is put together in the KIPP app, where you can review and
        edit the details. A richer editor for this kind of request is coming soon.
      </p>
    </div>
  );
}
