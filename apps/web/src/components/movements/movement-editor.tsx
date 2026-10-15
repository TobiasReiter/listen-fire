"use client";

/**
 * CodeMirror 6 editor for `.mvt` movement scripts.
 *
 * Everything language-aware comes from the movement-lang language service,
 * driven by the team's catalog snapshot:
 *   - linting:    getMovementDiagnostics (debounced by @codemirror/lint);
 *   - completion: getMovementCompletions;
 *   - hover:      getHoverInfo.
 * The component is a thin adapter from those pure functions to CodeMirror
 * extension points — no network calls in here.
 *
 * The snapshot STREAMS: the page fetches a fast skeleton (no instance
 * schemas), then merges per-(adapter, credential) schemas as the source
 * references them. Each new snapshot updates a ref and forces a re-lint —
 * the editor view itself is created once and never rebuilt, so text,
 * cursor, and undo history survive schema arrivals. Diagnostics only
 * tighten as schemas land (the checker is silent on unknown schemas).
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { forceLinting, linter, lintGutter } from "@codemirror/lint";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion as CmCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { getCM, vim } from "@replit/codemirror-vim";
import {
  getDefinition,
  getHoverInfo,
  getMovementCompletions,
  getMovementDiagnostics,
  type CatalogSnapshot,
  type CompletionKind,
  type DefinitionTarget,
  type LanguageVersion,
  type MovementDiagnostic,
} from "movement-lang";

import { movementSyntax } from "./movement-language";

export interface MovementEditorHandle {
  /** Select + scroll a source range into view (diagnostics panel clicks). */
  revealRange: (from: number, to: number) => void;
  getSource: () => string;
  /** Replace the whole document (listener pause/resume edits the script in
   *  place). One transaction, so a single undo restores the previous text. */
  setSource: (next: string) => void;
  /** Typewriter the diff from the current doc to `next` — the demo build
   *  stage's "watch it come together" (plans/2026-06-16-demo-build-stage).
   *  Cancels any in-flight animation. */
  animateToSource: (next: string) => void;
}

export interface MovementEditorProps {
  initialValue: string;
  snapshot: CatalogSnapshot;
  /** The saved movement's language version — the text is checked as the
   *  version it is written in. Absent (a new movement) ⇒ the current one. */
  languageVersion?: LanguageVersion;
  onChange?: (source: string) => void;
  /** Fires with each lint pass — drives the page's diagnostics panel. */
  onDiagnostics?: (diagnostics: MovementDiagnostic[]) => void;
  /** Vim keybindings (toggled live — the view is reconfigured in place). */
  vimEnabled?: boolean;
  /** Reports the current vim mode ("normal", "insert", …; null when off). */
  onVimModeChange?: (mode: string | null) => void;
  /** Soft-wrap long lines (toggled live — the view is reconfigured in place). */
  lineWrap?: boolean;
  /** Cmd/ctrl-click on an imported name (or an import statement's tokens)
   *  navigates to its source. The caller owns the URL mapping (file
   *  name → movement page, adapters/credentials/plugins → their pages);
   *  absent = navigation off. */
  onNavigate?: (target: DefinitionTarget) => void;
  /** A "+ connect" completion was picked. The caller dispatches to the
   *  app's connect-action handler registry by `kind` (it owns the tRPC
   *  client + catalog refresh); absent = connect entries stay inert. The
   *  declaration comes from the adapter manifest — the editor only relays it. */
  onConnectAction?: (action: {
    kind: string;
    adapter: string;
    credential?: string;
  }) => void;
}

const COMPLETION_TYPE: Record<CompletionKind, string> = {
  value: "variable",
  option: "enum",
  operator: "keyword",
  keyword: "keyword",
  function: "function",
  edge: "property",
  special: "constant",
};

// JetBrains Mono is loaded app-wide (globals.css); fall back to the
// system mono stack while it streams in.
const MONO_STACK =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const theme = EditorView.theme({
  "&": {
    fontSize: "13px",
    height: "100%",
    backgroundColor: "#ffffff",
    color: "#1f2937",
  },
  ".cm-scroller": {
    fontFamily: MONO_STACK,
    lineHeight: "1.7",
  },
  ".cm-content": { padding: "20px 0 32px" },
  ".cm-line": { padding: "0 24px" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "#d1d5db",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "44px",
    padding: "0 8px 0 16px",
  },
  ".cm-activeLine": { backgroundColor: "rgba(135, 120, 247, 0.05)" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "#9ca3af",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "#6B5BD4",
    borderLeftWidth: "1.5px",
  },
  "&.cm-focused .cm-fat-cursor": { background: "#8778F7" },
  "&:not(.cm-focused) .cm-fat-cursor": {
    background: "none",
    outline: "solid 1px #8778F7",
  },
  ".cm-selectionBackground": { background: "rgba(135, 120, 247, 0.12)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "rgba(135, 120, 247, 0.18)",
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "rgba(135, 120, 247, 0.16)",
  },
  ".cm-tooltip": {
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    backgroundColor: "#ffffff",
    boxShadow:
      "0 12px 32px rgba(17, 24, 39, 0.10), 0 2px 8px rgba(17, 24, 39, 0.04)",
    fontSize: "12px",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: MONO_STACK,
    maxHeight: "280px",
    padding: "4px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "4px 8px",
    borderRadius: "6px",
    lineHeight: "1.5",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "#F5F3FE",
    color: "#3C307D",
  },
  ".cm-completionDetail": {
    color: "#9ca3af",
    fontStyle: "normal",
    marginLeft: "1.25em",
  },
  ".cm-diagnostic": { padding: "8px 12px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid #ef4444" },
  ".cm-lintRange-error": {
    backgroundImage:
      "url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2IiBoZWlnaHQ9IjMiPjxwYXRoIGQ9Im0wIDMgbDIgLTIgbDEgMCBsMiAyIGwxIDAiIHN0cm9rZT0iI2RjMjYyNiIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIxIi8+PC9zdmc+')",
  },
  ".cm-panels": {
    backgroundColor: "#fafafa",
    borderTop: "1px solid #f3f4f6",
    color: "#4b5563",
  },
  ".cm-vim-panel": {
    padding: "4px 16px",
    fontFamily: MONO_STACK,
    fontSize: "12px",
  },
  ".cm-vim-panel input": {
    fontFamily: MONO_STACK,
    fontSize: "12px",
  },
});

const movementHoverDocs = (snapshotRef: { current: CatalogSnapshot }) =>
  hoverTooltip((view, pos) => {
    // The analyzer can throw on a program shape it doesn't handle yet — one
    // bad hover must degrade THAT request, not kill hover document-wide.
    let info;
    try {
      info = getHoverInfo(view.state.doc.toString(), pos, snapshotRef.current);
    } catch (err) {
      console.error("Movement hover failed:", err);
      return null;
    }
    if (!info) return null;
    return {
      pos: info.from,
      end: info.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.style.padding = "10px 12px";
        dom.style.maxWidth = "440px";
        dom.style.maxHeight = "320px";
        dom.style.lineHeight = "1.5";
        // Field lists carry one field per line (\n-delimited); preserve that
        // whitespace and let long lines (e.g. a wide enum) scroll off to the
        // right rather than wrapping into an unreadable run.
        dom.style.overflow = "auto";
        for (let i = 0; i < info.contents.length; i++) {
          const line = document.createElement("div");
          line.textContent = info.contents[i];
          line.style.whiteSpace = "pre";
          if (i === 0) {
            line.style.fontWeight = "600";
            line.style.color = "#111827";
            line.style.fontFamily = MONO_STACK;
          } else {
            line.style.color = "#6b7280";
            line.style.marginTop = "3px";
            line.style.fontFamily = MONO_STACK;
          }
          dom.appendChild(line);
        }
        return { dom };
      },
    };
  });

// ── Cmd/ctrl-click navigation ──
//
// While the modifier is held, hovering a token with a definition target
// underlines it (the affordance); clicking it fires `onNavigate`. The
// target comes from the language service's getDefinition — import-line
// tokens and imported names at use sites; everything else stays inert.

const setNavLink = StateEffect.define<{ from: number; to: number } | null>();

const navLinkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setNavLink)) {
        deco = effect.value
          ? Decoration.set([
              Decoration.mark({ class: "cm-definition-link" }).range(
                effect.value.from,
                effect.value.to,
              ),
            ])
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The clickable token range at `pos`: a word, or the quoted path of an
 *  import line — mirrors what getDefinition resolves. */
function navTokenAt(
  doc: string,
  pos: number,
): { from: number; to: number } | undefined {
  let from = pos;
  while (from > 0 && /[A-Za-z0-9_]/.test(doc[from - 1])) from--;
  let to = pos;
  while (to < doc.length && /[A-Za-z0-9_]/.test(doc[to])) to++;
  if (from !== to) return { from, to };
  // Inside an import path: expand between the quotes.
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = doc.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = doc.length;
  const line = doc.slice(lineStart, lineEnd);
  if (!/^\s*import\b/.test(line)) return undefined;
  const open = doc.lastIndexOf('"', pos - 1);
  const close = doc.indexOf('"', pos);
  if (open < lineStart || close === -1 || close >= lineEnd) return undefined;
  return { from: open + 1, to: close };
}

const definitionNavigation = (
  snapshotRef: { current: CatalogSnapshot },
  callbacksRef: {
    current: { onNavigate?: (target: DefinitionTarget) => void };
  },
) => {
  const clear = (view: EditorView) => {
    if (view.state.field(navLinkField).size > 0) {
      view.dispatch({ effects: setNavLink.of(null) });
    }
  };
  const targetAt = (view: EditorView, event: MouseEvent) => {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return undefined;
    const doc = view.state.doc.toString();
    const token = navTokenAt(doc, pos);
    if (!token) return undefined;
    let target;
    try {
      target = getDefinition(doc, pos, snapshotRef.current);
    } catch (err) {
      console.error("Movement definition lookup failed:", err);
      return undefined;
    }
    return target ? { target, token } : undefined;
  };
  return [
    navLinkField,
    EditorView.domEventHandlers({
      mousemove(event, view) {
        if (
          !callbacksRef.current.onNavigate ||
          !(event.metaKey || event.ctrlKey)
        ) {
          clear(view);
          return false;
        }
        const hit = targetAt(view, event);
        if (hit) view.dispatch({ effects: setNavLink.of(hit.token) });
        else clear(view);
        return false;
      },
      mousedown(event, view) {
        if (
          !callbacksRef.current.onNavigate ||
          !(event.metaKey || event.ctrlKey)
        )
          return false;
        const hit = targetAt(view, event);
        if (!hit) return false;
        event.preventDefault();
        callbacksRef.current.onNavigate(hit.target);
        clear(view);
        return true;
      },
      keyup(_event, view) {
        clear(view);
        return false;
      },
      mouseleave(_event, view) {
        clear(view);
        return false;
      },
    }),
    EditorView.theme({
      ".cm-definition-link": {
        textDecoration: "underline",
        textUnderlineOffset: "3px",
        textDecorationColor: "#8778F7",
        cursor: "pointer",
      },
    }),
  ];
};

// Line-level diff for the build-stage animation (plans/2026-06-16-demo-build-stage).
// Common-prefix/suffix LINE trim + positional window alignment, so edits are
// bound tightly to the lines that actually change — an append only touches the
// new tail, a one-line edit only that line. Tight for the common cases; a
// structural change degrades to line-by-line replacement of the changed window,
// never a delete-everything-and-retype.
type LineOp =
  | { t: "keep" }
  | { t: "del" }
  | { t: "ins"; line: string }
  | { t: "rep"; line: string };

// Standard LCS diff → keep (common subsequence) / del (old-only) / ins (new-only),
// in document order. O(n·m) — fine for a movement's handful of lines.
function lcsDiff(a: string[], b: string[]): LineOp[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ t: "keep" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "del" });
      i++;
    } else {
      ops.push({ t: "ins", line: b[j] });
      j++;
    }
  }
  while (i < m) {
    ops.push({ t: "del" });
    i++;
  }
  while (j < n) {
    ops.push({ t: "ins", line: b[j] });
    j++;
  }
  return ops;
}

// A del immediately followed by an ins is a line CHANGED in place → edit it
// (clear + retype) rather than removing one line and adding a fresh one.
function coalesceReplaces(ops: LineOp[]): LineOp[] {
  const out: LineOp[] = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (op.t === "ins" && prev && prev.t === "del") {
      out[out.length - 1] = { t: "rep", line: op.line };
    } else {
      out.push(op);
    }
  }
  return out;
}

function lineDiffOps(curLines: string[], targetLines: string[]): LineOp[] {
  let p = 0;
  const maxP = Math.min(curLines.length, targetLines.length);
  while (p < maxP && curLines[p] === targetLines[p]) p++;
  let s = 0;
  while (
    s < Math.min(curLines.length, targetLines.length) - p &&
    curLines[curLines.length - 1 - s] ===
      targetLines[targetLines.length - 1 - s]
  )
    s++;
  const oldMid = curLines.slice(p, curLines.length - s);
  const newMid = targetLines.slice(p, targetLines.length - s);
  const ops: LineOp[] = [];
  for (let i = 0; i < p; i++) ops.push({ t: "keep" });
  // LCS on the changed window — keeps unchanged lines even when shifted by an
  // insert/delete above, so they DON'T needlessly refresh.
  ops.push(...coalesceReplaces(lcsDiff(oldMid, newMid)));
  for (let i = 0; i < s; i++) ops.push({ t: "keep" });
  return ops;
}

export const MovementEditor = forwardRef<
  MovementEditorHandle,
  MovementEditorProps
>(function MovementEditor(
  {
    initialValue,
    snapshot,
    languageVersion,
    onChange,
    onDiagnostics,
    vimEnabled,
    onVimModeChange,
    lineWrap,
    onNavigate,
    onConnectAction,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacksRef = useRef({
    onChange,
    onDiagnostics,
    onVimModeChange,
    onNavigate,
    onConnectAction,
  });
  callbacksRef.current = {
    onChange,
    onDiagnostics,
    onVimModeChange,
    onNavigate,
    onConnectAction,
  };
  const snapshotRef = useRef(snapshot);
  const languageVersionRef = useRef(languageVersion);
  languageVersionRef.current = languageVersion;
  const vimCompartmentRef = useRef(new Compartment());
  const wrapCompartmentRef = useRef(new Compartment());
  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Demo build stage: drafts play SEQUENTIALLY (skeleton fully types in, then
  // each fill diff) rather than cancelling each other, so the user watches it
  // come together in stages (plans/2026-06-16-demo-build-stage).
  const animQueueRef = useRef<string[]>([]);
  const animatingRef = useRef(false);
  const runAnimRef = useRef<() => void>(() => {});
  runAnimRef.current = () => {
    const view = viewRef.current;
    if (!view) {
      animatingRef.current = false;
      animQueueRef.current = [];
      return;
    }
    // Dequeue the next target that actually differs from the current doc. A new
    // draft only starts once the previous one has fully rendered (this is only
    // re-entered when the prior op-sequence finishes), so streams never overlap.
    let next: string | null = null;
    while (animQueueRef.current.length > 0) {
      const t = animQueueRef.current.shift() as string;
      if (t !== view.state.doc.toString()) {
        next = t;
        break;
      }
    }
    if (next === null) {
      animatingRef.current = false;
      return;
    }
    animatingRef.current = true;

    // One word + its trailing whitespace per tick; steady, deliberate cadence.
    const WORD_MS = 75;
    const STEP_GAP_MS = 50;
    const ops = lineDiffOps(
      view.state.doc.toString().split("\n"),
      next.split("\n"),
    );
    let opIndex = 0;
    let lineNo = 1; // 1-based doc line the next op acts on

    const clearTimer = () => {
      if (animTimerRef.current) {
        clearInterval(animTimerRef.current);
        animTimerRef.current = null;
      }
    };
    const docLine = (n: number) => {
      const v = viewRef.current!;
      return v.state.doc.line(Math.min(Math.max(n, 1), v.state.doc.lines));
    };
    // Type `text` word-by-word at char `from`, cursor trailing, then onDone.
    const typeWords = (from: number, text: string, onDone: () => void) => {
      const tokens = text.match(/\s*\S+\s*/g) ?? (text ? [text] : []);
      if (tokens.length === 0) {
        onDone();
        return;
      }
      let ti = 0;
      let at = from;
      view.focus();
      animTimerRef.current = setInterval(() => {
        const v = viewRef.current;
        if (!v) {
          clearTimer();
          animatingRef.current = false;
          return;
        }
        const piece = tokens[ti] ?? "";
        v.dispatch({
          changes: { from: at, to: at, insert: piece },
          selection: { anchor: at + piece.length },
          effects: EditorView.scrollIntoView(at + piece.length, {
            y: "center",
          }),
        });
        at += piece.length;
        ti += 1;
        if (ti >= tokens.length) {
          clearTimer();
          onDone();
        }
      }, WORD_MS);
    };

    const advance = () => {
      lineNo += 1;
      opIndex += 1;
      setTimeout(step, STEP_GAP_MS);
    };

    function step() {
      const v = viewRef.current;
      if (!v) {
        clearTimer();
        animatingRef.current = false;
        return;
      }
      while (opIndex < ops.length && ops[opIndex].t === "keep") {
        lineNo += 1;
        opIndex += 1;
      }
      if (opIndex >= ops.length) {
        animatingRef.current = false;
        runAnimRef.current(); // play the next queued draft, if any
        return;
      }
      const op = ops[opIndex];
      if (op.t === "del") {
        const line = docLine(lineNo);
        if (v.state.doc.lines === 1) {
          v.dispatch({
            changes: { from: 0, to: line.to, insert: "" },
            selection: { anchor: 0 },
          });
        } else if (lineNo < v.state.doc.lines) {
          v.dispatch({
            changes: { from: line.from, to: line.to + 1, insert: "" },
            selection: { anchor: line.from },
          });
        } else {
          v.dispatch({
            changes: { from: line.from - 1, to: line.to, insert: "" },
            selection: { anchor: line.from - 1 },
          });
        }
        opIndex += 1; // lineNo stays — the next line shifted into this slot
        setTimeout(step, STEP_GAP_MS);
      } else if (op.t === "rep") {
        // Update just this line in place: clear it, then type the new content.
        const line = docLine(lineNo);
        v.dispatch({
          changes: { from: line.from, to: line.to, insert: "" },
          selection: { anchor: line.from },
        });
        typeWords(line.from, op.line, advance);
      } else if (op.t === "ins") {
        // Insert a fresh line, then type into it.
        if (v.state.doc.length === 0) {
          typeWords(0, op.line, advance);
        } else if (lineNo <= v.state.doc.lines) {
          const at = docLine(lineNo).from;
          v.dispatch({
            changes: { from: at, to: at, insert: "\n" },
            selection: { anchor: at },
          });
          typeWords(at, op.line, advance);
        } else {
          const at = v.state.doc.length;
          v.dispatch({
            changes: { from: at, to: at, insert: "\n" },
            selection: { anchor: at + 1 },
          });
          typeWords(at + 1, op.line, advance);
        }
      }
    }

    step();
  };

  // Schemas stream in: refresh the ref and re-lint in place — never
  // rebuild the view (that would drop text, cursor, and undo history).
  useEffect(() => {
    snapshotRef.current = snapshot;
    if (viewRef.current) forceLinting(viewRef.current);
  }, [snapshot]);

  useImperativeHandle(ref, () => ({
    revealRange: (from, to) => {
      const view = viewRef.current;
      if (!view) return;
      const max = view.state.doc.length;
      const anchor = Math.min(from, max);
      const head = Math.min(to, max);
      view.dispatch({
        selection: { anchor, head },
        effects: EditorView.scrollIntoView(anchor, { y: "center" }),
      });
      view.focus();
    },
    getSource: () => viewRef.current?.state.doc.toString() ?? "",
    setSource: (next) => {
      const view = viewRef.current;
      if (!view) return;
      animQueueRef.current = [];
      animatingRef.current = false;
      if (animTimerRef.current) {
        clearInterval(animTimerRef.current);
        animTimerRef.current = null;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    },
    animateToSource: (next) => {
      if (!viewRef.current) return;
      const last = animQueueRef.current[animQueueRef.current.length - 1];
      if (next === last) return; // already queued
      animQueueRef.current.push(next);
      if (!animatingRef.current) runAnimRef.current();
    },
  }));

  useEffect(
    () => () => {
      if (animTimerRef.current) clearInterval(animTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const movementLinter = linter(
      (view) => {
        const pinned = languageVersionRef.current;
        const diagnostics = getMovementDiagnostics(
          view.state.doc.toString(),
          snapshotRef.current,
          pinned !== undefined ? { languageVersion: pinned } : undefined,
        );
        callbacksRef.current.onDiagnostics?.(diagnostics);
        return diagnostics.map((d) => ({
          from: d.from,
          to: d.to,
          severity:
            (d.severity ?? "error") === "info"
              ? ("info" as const)
              : (d.severity ?? "error") === "warning"
                ? ("warning" as const)
                : ("error" as const),
          message: d.message,
          source: d.code,
        }));
      },
      { delay: 350 },
    );

    const movementCompletions = (
      context: CompletionContext,
    ): CompletionResult | null => {
      let result;
      try {
        result = getMovementCompletions(
          context.state.doc.toString(),
          context.pos,
          snapshotRef.current,
          languageVersionRef.current !== undefined
            ? { languageVersion: languageVersionRef.current }
            : undefined,
        );
      } catch (err) {
        console.error("Movement completions failed:", err);
        return null;
      }
      const { from, items } = result;
      if (items.length === 0) return null;
      // Only pop up unprompted when a word/trigger character is being typed.
      if (!context.explicit && context.pos === from) {
        const before = context.state.sliceDoc(
          Math.max(0, context.pos - 1),
          context.pos,
        );
        if (!/[\w.:`[{(,$ ]/.test(before) || before === " ") return null;
      }
      const options: CmCompletion[] = items.map((item) => {
        // A "+ connect" entry inserts no text — it dispatches to the app's
        // connect-action handler registry by `kind`. We strip whatever
        // partial word the author was typing (the completion range) and
        // hand off; the handler runs the interactive flow (e.g. the Drive
        // Picker) and refreshes the catalog so the new entry appears.
        if (item.connectAction) {
          const action = item.connectAction;
          return {
            label: item.label,
            type: "constant",
            ...(item.detail !== undefined ? { detail: item.detail } : {}),
            apply: (
              view: EditorView,
              _completion: CmCompletion,
              fromPos: number,
              toPos: number,
            ) => {
              view.dispatch({
                changes: { from: fromPos, to: toPos, insert: "" },
              });
              callbacksRef.current.onConnectAction?.(action);
            },
          };
        }
        return {
          label: item.label,
          apply: item.insert,
          type: COMPLETION_TYPE[item.kind],
          ...(item.detail !== undefined ? { detail: item.detail } : {}),
        };
      });
      return { from, options, validFor: /^[\w`#]*$/ };
    };

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          // Vim must sit ahead of the other keymaps so it sees keys first;
          // the compartment lets the toggle reconfigure the live view.
          vimCompartmentRef.current.of([]),
          wrapCompartmentRef.current.of(lineWrap ? EditorView.lineWrapping : []),
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          ...movementSyntax,
          movementLinter,
          lintGutter(),
          autocompletion({ override: [movementCompletions] }),
          movementHoverDocs(snapshotRef),
          definitionNavigation(snapshotRef, callbacksRef),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              callbacksRef.current.onChange?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-once: initialValue is only the seed; snapshot updates flow
    // through snapshotRef + forceLinting above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle vim in place — reconfiguring the compartment keeps text,
  // cursor, and history. While on, relay mode changes ("normal",
  // "insert", "visual line", …) for the status strip.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: vimCompartmentRef.current.reconfigure(vimEnabled ? vim() : []),
    });
    if (!vimEnabled) {
      callbacksRef.current.onVimModeChange?.(null);
      return;
    }
    const cm = getCM(view);
    const report = (event?: { mode?: string; subMode?: string }) => {
      const mode = event?.mode ?? "normal";
      const subMode =
        event?.subMode === "linewise"
          ? " line"
          : event?.subMode === "blockwise"
            ? " block"
            : "";
      callbacksRef.current.onVimModeChange?.(`${mode}${subMode}`);
    };
    report();
    cm?.on("vim-mode-change", report);
    return () => {
      cm?.off("vim-mode-change", report);
    };
  }, [vimEnabled]);

  // Toggle line wrapping in place — reconfiguring the compartment keeps
  // text, cursor, and history.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartmentRef.current.reconfigure(
        lineWrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [lineWrap]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" />;
});
