"use client";

import { createContext, Fragment, useContext, useMemo } from "react";
import {
  Layers,
  Link2,
  MousePointerClick,
  OctagonX,
  PauseCircle,
  RefreshCw,
  Sparkles,
  Timer,
  Trash2,
  Unlink,
  Variable,
} from "lucide-react";
import type { Step, StoryArg } from "movement-lang";
import type { StoryView, StoryViewRecord } from "./view";

import { BOX, LIFT } from "./canvas-style";
import {
  NodeCard,
  RecordCard,
  StepCard,
  TriggerCard,
  endpointName,
  relationsOf,
} from "./cards";
import { ValueChip } from "./chips";
import { ExtractTree } from "./extract-tree";
import {
  callersOf,
  collectCallers,
  columnsOf,
  contenderNamed,
  movementsByName,
  racesByBinding,
  sectionsOf,
  type FlowColumn,
  type MovementStep,
  type RaceStep,
} from "./flow-sections";
import { LinksProvider, MovementLink, pointedStyle, useColumnLink } from "./links";
import { ArgumentCard, ParamCard } from "./params";
import { PannableSurface, originAttribute, readable } from "./pannable-surface";
import { COLUMN_GAP, NODE_MAX } from "./sizing";
import { Alias, AliasChip, BoundName, WrittenRecord } from "./referents";
import { TraversalHeading, Traversals, traversalsOf } from "./traversal";

/**
 * The canvas: the automation's CONTROL FLOW, top to bottom — and, when the file
 * holds more than one story, a BOARD of those columns side by side.
 *
 * One spine in program order. Only the two exclusive forks get lanes — an
 * if/otherwise and a race — because side-by-side reads as "different things
 * happen"; a for-each is "the same thing, many times", so it gets a frame with
 * one way in and one way out. An ask cuts clean across the spine, because
 * everything below it genuinely waits.
 *
 * Nothing is measured off the DOM. Lanes are equal-width grid tracks, so a
 * fan's ends are known before layout: an SVG stretched across the same width
 * lands on the lane centres by construction, and stays there at any size. A
 * column's width comes from the same place — the shape of the story in it —
 * never from the pane, which is what would have squeezed a three-way branch
 * into the room a straight line needs. It comes from the CONTENT, too: a
 * column is as wide as the widest thing in it and no wider (see `sizing`).
 *
 * Honesty rule inherited from the design: an arm that STOPS THE RUN gets a
 * terminal cap and no line back to the spine. Termination is a PROJECTED fact
 * (`Step['terminates']`), computed once by the checker's own rule and carried
 * through the story — never re-derived here, which is how this stayed in sync
 * with the language instead of drifting the day it grows another terminator.
 *
 */
export function FlowCanvas({ view }: { view: StoryView }) {
  const data = useMemo<CanvasData>(() => {
    const records = new Map(view.records.map((record) => [record.id, record]));
    return { records, relations: relationsOf({ edges: view.edges, records }) };
  }, [view]);
  const traversals = useMemo(() => traversalsOf(view), [view]);

  const columns = useMemo(() => columnsOf(sectionsOf(view)), [view]);
  // Where the reader starts: the first story that FIRES, because that is the
  // one that happens on its own. A file of helpers alone opens on its first
  // column rather than on nothing.
  const origin = useMemo(() => {
    const fired = columns.findIndex((column) => column.kind === "fired");
    return fired === -1 ? 0 : fired;
  }, [columns]);
  const callers = useMemo(() => collectCallers(view.flow), [view.flow]);
  const movements = useMemo(() => movementsByName(view.flow), [view.flow]);
  const races = useMemo(() => racesByBinding(view.flow), [view.flow]);

  if (view.flow.length === 0 && view.triggers.length === 0) {
    return (
      <p {...readable("text-[13px] text-gray-400")}>
        This script doesn’t do anything yet.
      </p>
    );
  }

  return (
    <Canvas.Provider value={data}>
      <Traversals.Provider value={traversals}>
        <Races.Provider value={races}>
          <Movements.Provider value={movements}>
            {/* The canvas is a SURFACE — the same engineering grid the marketing
                site draws — and the cards sit on it. */}
            <PannableSurface>
              <LinksProvider>
                {/* No auto margins: the board is as wide as its columns need,
                    and the surface opens with the origin column in the middle
                    of the pane — so a single small story is centred by where
                    the board is looked at, not by where it sits.

                    The GAP is what holds two stories apart. It used to be a
                    dashed rule between two columns that were each padded out to
                    a fixed width, so the separation was mostly slack; with
                    columns shrunk to their content the room between them has to
                    be room. */}
                <div className={`flex w-max items-stretch ${COLUMN_GAP}`}>
                  {columns.map((column, index) => (
                    <Column key={column.key} column={column} origin={index === origin}>
                      <ColumnBody column={column} named={columns.length > 1} callers={callers} />
                    </Column>
                  ))}
                </div>
              </LinksProvider>
            </PannableSurface>
          </Movements.Provider>
        </Races.Provider>
      </Traversals.Provider>
    </Canvas.Provider>
  );
}

/**
 * One column's room on the board, and the place a link lands. A column is what
 * a call points AT, so it registers under the movement it tells and lights up
 * while anything on the board points at it.
 *
 * It has NO width of its own: it is exactly as wide as the widest thing in it,
 * which is what makes a two-card story read as a two-card story instead of as
 * a two-card story adrift in the room a three-way branch would have needed.
 * Every node inside caps and wraps (`NODE_MAX`), so "the widest thing in it" is
 * a bounded question however long a sentence runs.
 */
function Column({
  column,
  origin,
  children,
}: {
  column: FlowColumn;
  /** This is the column the board opens on. */
  origin: boolean;
  children: React.ReactNode;
}) {
  const name = "movement" in column ? column.movement.name : undefined;
  const { ref, pointed } = useColumnLink(name);
  return (
    <div
      ref={ref}
      {...originAttribute(origin)}
      className={`shrink-0 px-5 py-1 transition-colors ${BOX} ${pointedStyle(pointed)}`}
    >
      <div className="flex flex-col items-center">{children}</div>
    </div>
  );
}

/**
 * One column: an independent story, told top to bottom. Nothing connects it to
 * the column beside it, because nothing connects them in the file either —
 * they are separate things that start on their own.
 */
function ColumnBody({
  column,
  named,
  callers,
}: {
  column: FlowColumn;
  named: boolean;
  callers: Map<string, Set<string>>;
}) {
  switch (column.kind) {
    // Steps written outside any movement: no start of their own to show.
    case "loose":
      return <Spine steps={column.steps} />;

    // A story that STARTS has somewhere to end, and saying so is the last thing
    // the reader needs: the spine stops here, and nothing below it runs. A
    // movement whose every path already ends the run says that on each of those
    // paths, so a second ending would be one too many — and `terminates` is the
    // checker's own answer to that, carried through the story.
    case "fired":
      return (
        <>
          {named && <SectionName>{column.movement.name}</SectionName>}
          <Caption>Starts when</Caption>
          <Start triggers={column.triggers} />
          <Drop />
          <Spine steps={column.movement.steps} />
          {!column.movement.terminates && (
            <>
              <Drop height={14} />
              <EndCap />
            </>
          )}
        </>
      );

    // A trigger whose `fires` names nothing declared — the hole is on the card
    // itself; there is no spine to draw under it.
    case "orphan":
      return (
        <>
          <Caption>Starts when</Caption>
          <Start triggers={column.triggers} />
        </>
      );

    // A helper has no start of its own — something else runs it — so the two
    // things a reader needs before the steps are WHO runs it and WHAT it is
    // given. It opens the way a fired story does, with the same shape: a line
    // saying where the run comes from, then the thing that comes in, then the
    // spine.
    case "helper":
      return (
        <>
          {named && <SectionName>{column.movement.name}</SectionName>}
          <UsedBy name={column.movement.name} callers={callers} />
          {column.movement.params.length > 0 && (
            <>
              <Caption>Runs with</Caption>
              <div className="flex w-full flex-col items-center gap-2">
                {column.movement.params.map((param) => (
                  <ParamCard key={param.name} param={param} />
                ))}
              </div>
              <Drop />
            </>
          )}
          <Spine steps={column.movement.steps} />
        </>
      );

    default: {
      const exhaustive: never = column;
      return exhaustive;
    }
  }
}

/**
 * Who runs this helper, as links to their columns. Every name is a movement the
 * file declares, so each one is somewhere the reader can be taken; a call made
 * by the loose steps at the top level names no column, and reads as words.
 */
function UsedBy({ name, callers }: { name: string; callers: Map<string, Set<string>> }) {
  const movements = useContext(Movements);
  const found = callersOf(name, callers);
  if (found.length === 0) {
    return (
      <p {...readable("mb-3 text-center text-[11.5px] text-gray-400")}>
        Nothing runs this yet.
      </p>
    );
  }
  return (
    <p {...readable(`mb-3 ${NODE_MAX} text-center text-[11.5px] leading-[19px] text-gray-500`)}>
      Run by{" "}
      {found.map((caller, index) => (
        <Fragment key={caller}>
          {index > 0 && (index === found.length - 1 ? " and " : ", ")}
          <MovementLink name={caller} known={movements.has(caller)} />
        </Fragment>
      ))}
    </p>
  );
}

// ── What every node can look up ─────────────────────────────────────────────

interface CanvasData {
  records: Map<string, StoryViewRecord>;
  relations: Map<string, string[]>;
}

const Canvas = createContext<CanvasData>({
  records: new Map(),
  relations: new Map(),
});

/** The movements this file declares, by name — what a call resolves against. */
const Movements = createContext<Map<string, MovementStep>>(new Map());

/** The races this file runs, by the name each binds — what a receipt branch
 *  resolves against, so it can say which contender won rather than that
 *  something came back. */
const Races = createContext<Map<string, RaceStep>>(new Map());

// ── The spine ───────────────────────────────────────────────────────────────

function Spine({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return <Note>Nothing happens here.</Note>;
  return (
    <div className="flex w-full flex-col items-center">
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 && <Drop />}
          <StepNode step={step} />
        </Fragment>
      ))}
    </div>
  );
}

/** The line from one node to the next. */
function Drop({ height = 22 }: { height?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 flex-col items-center"
      style={{ height }}
    >
      <span className="w-px flex-1 bg-gray-300" />
      <svg width="7" height="4" viewBox="0 0 7 4" className="fill-gray-300">
        <path d="M0 0 L3.5 4 L7 0 z" />
      </svg>
    </span>
  );
}

/** Fills whatever height a short lane has left, so its line reaches the join. */
function Slack() {
  return <span aria-hidden className="w-px flex-1 bg-gray-300" />;
}

// ── Forks ───────────────────────────────────────────────────────────────────

const FAN = 26;

/**
 * The split and join connectors, as ORTHOGONAL trees: down out of the spine, a
 * single horizontal run across, then down into each lane (and the mirror image
 * for a join). Straight segments and square corners — the drawing says "this
 * goes there" and nothing else, where a curve was decoration.
 *
 * The SVG is stretched to the lane row's width (`preserveAspectRatio="none"`),
 * so lane centres are a fraction of the box and need no measurement. Only the
 * one horizontal segment is affected by that stretch, and a horizontal line
 * stretches to a horizontal line; `vector-effect` keeps every stroke hairline.
 *
 * `(i + 0.5) / count` is the lane's centre ONLY while the lanes tile the row
 * EQUALLY with nothing between them — which is why `Lanes` is equal tracks
 * separated by padding INSIDE each one, never by a gap between them, whatever
 * those tracks are sized from. A gap is room the fan cannot see: it makes each
 * lane narrower than its share without moving the fraction, so every drop lands off
 * its lane's centre by a quarter of the gap, outwards. That is the kink Redline
 * 10 reports, and an empty lane is where it shows, because there the lane's own
 * line runs the full height with nothing to hide the join it misses.
 *
 */
function Fan({
  count,
  mode,
  skip,
}: {
  count: number;
  mode: "split" | "join";
  skip?: number[];
}) {
  const centres = Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * 100);
  const live = centres.filter((_, index) => !skip?.includes(index));
  const mid = FAN / 2;
  const from = Math.min(50, ...live);
  const to = Math.max(50, ...live);
  return (
    <svg
      aria-hidden
      width="100%"
      height={FAN}
      viewBox={`0 0 100 ${FAN}`}
      preserveAspectRatio="none"
      className="w-full shrink-0"
      fill="none"
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
    >
      {live.length > 0 && (
        <>
          {/* The stem out of the spine, the run across, and one drop per lane. */}
          <path
            vectorEffect="non-scaling-stroke"
            className="stroke-gray-300"
            d={mode === "split" ? `M 50 0 V ${mid}` : `M 50 ${FAN} V ${mid}`}
          />
          <path
            vectorEffect="non-scaling-stroke"
            className="stroke-gray-300"
            d={`M ${from} ${mid} H ${to}`}
          />
          {live.map((x, index) => (
            <path
              key={index}
              vectorEffect="non-scaling-stroke"
              className="stroke-gray-300"
              d={mode === "split" ? `M ${x} ${mid} V ${FAN}` : `M ${x} 0 V ${mid}`}
            />
          ))}
        </>
      )}
    </svg>
  );
}

interface Lane {
  label?: React.ReactNode;
  steps?: Step[];
  body?: React.ReactNode;
  /** This lane ends the run: it gets a cap instead of a line back. */
  stops?: boolean;
}

/**
 * The lanes themselves. They TILE the row — equal tracks with no gap between
 * them — so each lane's centre is exactly the fraction `Fan` draws to. The
 * breathing room is symmetric padding INSIDE each lane, which moves no centre;
 * a gap between tracks would (see `Fan`).
 *
 * Equal AND sized to content, which is the whole trick: `1fr` tracks under an
 * intrinsic width all take the width of the widest ITEM across them, so a fork
 * of three short lanes is narrow and a fork of one long lane is wide, without
 * either stopping the tiling being exact. `minmax(0, …)` is what keeps a long
 * word inside its lane rather than pushing the track past its share. A nested
 * fork composes for free: its own row is one item in its lane, so it sizes
 * within that lane's width the same way.
 *
 */
function Lanes({ lanes, connect }: { lanes: Lane[]; connect: boolean }) {
  return (
    <div
      className="grid w-full items-stretch"
      style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))` }}
    >
      {lanes.map((lane, index) => (
        <div key={index} className="flex min-w-0 flex-1 flex-col items-center px-1.5">
          {lane.label !== undefined && (
            <>
              <LaneLabel>{lane.label}</LaneLabel>
              <Drop height={14} />
            </>
          )}
          {lane.body ?? (lane.steps && lane.steps.length > 0 ? <Spine steps={lane.steps} /> : null)}
          {lane.stops ? (
            // An `ERROR` renders as its own end; capping it again would say the
            // same thing twice.
            !endsInError(lane.steps) && (
              <>
                <Drop height={14} />
                <TerminalCap />
              </>
            )
          ) : (
            connect && <Slack />
          )}
        </div>
      ))}
    </div>
  );
}

/** More than one way in is still one spine: the starts fan into it. */
function Start({ triggers }: { triggers: StoryView["triggers"] }) {
  const first = triggers[0];
  if (triggers.length === 1 && first) return <TriggerCard trigger={first} />;
  return (
    <>
      <Lanes
        connect
        lanes={triggers.map((trigger) => ({ body: <TriggerCard trigger={trigger} /> }))}
      />
      <Fan count={triggers.length} mode="join" />
    </>
  );
}

/** A fork: one head, lanes, and a join back to the spine for every lane that
 *  carries on. */
function Fork({
  head,
  lanes,
  join,
}: {
  head: React.ReactNode;
  lanes: Lane[];
  join?: React.ReactNode;
}) {
  const stopped = lanes.flatMap((lane, index) => (lane.stops ? [index] : []));
  const carriesOn = stopped.length < lanes.length;
  return (
    <div className="flex w-full flex-col items-center">
      {head}
      <Fan count={lanes.length} mode="split" />
      <Lanes lanes={lanes} connect={carriesOn} />
      {carriesOn && (
        <>
          <Fan count={lanes.length} mode="join" skip={stopped} />
          {join !== undefined && <JoinLabel>{join}</JoinLabel>}
        </>
      )}
    </div>
  );
}

// ── Steps ───────────────────────────────────────────────────────────────────

/**
 * What each collection op does, in the reader's words rather than its own name.
 * The function it runs stays unshown — a function's steps belong where it is
 * called — but which op and which collection are two facts the card can carry
 * for free, and without them the card reads as an anonymous stashed value.
 */
const COLLECTION_SENTENCE: Record<
  NonNullable<Extract<Step, { kind: "bind" }>["op"]>,
  string
> = {
  map: "Makes one new value out of each of these:",
  filter: "Keeps only the ones that match, out of these:",
  reduce: "Folds these down into a single value:",
  groupby: "Groups these by a key, several to a key:",
  keyby: "Files these under a key, one to a key:",
  sort: "Puts these in order, by what each answers:",
};

function StepNode({ step }: { step: Step }) {
  const { records, relations } = useContext(Canvas);

  switch (step.kind) {
    case "movement":
      return (
        <Frame head={<>What {step.name} does</>}>
          <Spine steps={step.steps} />
        </Frame>
      );

    case "match": {
      const record = records.get(step.record);
      if (!record) return <Plain>Looks for something.</Plain>;
      return <RecordCard record={record} relations={relations.get(record.id) ?? []} />;
    }

    case "write": {
      const record = records.get(step.record);
      if (!record) return <Plain>Changes something.</Plain>;
      return <RecordCard record={record} relations={relations.get(record.id) ?? []} />;
    }

    case "link":
      return (
        <StepCard
          signpost="Links"
          icon={<Link2 size={13} />}
          sentence={
            <>
              Connects {endpointName(step.from, records)} to{" "}
              {endpointName(step.to, records)} as {step.edge}.
            </>
          }
        />
      );

    case "unlink":
      return (
        <StepCard
          signpost="Unlinks"
          icon={<Unlink size={13} />}
          sentence={
            <>
              Removes the {step.edge} link between {endpointName(step.from, records)}{" "}
              and {endpointName(step.to, records)}.
            </>
          }
        />
      );

    // The extraction's shape IS the step — a frame around what it looks for,
    // the same container a for-each gets, because both are "one thing, drawn
    // with its contents inside it".
    case "extract":
      return step.tree ? (
        <Frame
          head={
            <>
              Reads{" "}
              {step.from.map((chip, index) => (
                <ValueChip key={index} chip={chip} />
              ))}{" "}
              and picks out:
            </>
          }
        >
          <ExtractTree tree={step.tree} />
        </Frame>
      ) : (
        <Plain>
          Reads{" "}
          {step.from.map((chip, index) => (
            <ValueChip key={index} chip={chip} />
          ))}{" "}
          and picks out the details.
        </Plain>
      );

    // The question itself is the card above — this is the cut it makes.
    case "ask":
      return (
        <Bar tone="pause" icon={<PauseCircle size={14} />}>
          Checks with you — everything below waits for your answer.
        </Bar>
      );

    case "wait":
      return (
        <Bar tone="quiet" icon={<Timer size={14} />}>
          {waitSentence(step.wait)}
        </Bar>
      );

    case "branch": {
      const single = step.arms.length === 1 && step.arms[0] !== undefined;
      const head = single ? (
        <Head>
          If <ValueChip chip={step.arms[0]!.condition} />
        </Head>
      ) : (
        <Head>One of these happens</Head>
      );
      const arms: Lane[] = step.arms.map((arm, index) => ({
        label: single ? (
          "Yes"
        ) : (
          <>
            {index === 0 ? "If" : "Otherwise if"} <ValueChip chip={arm.condition} />
          </>
        ),
        steps: arm.steps,
        stops: arm.terminates,
      }));
      // An `if` with nothing on the other side still forks: drawing the empty
      // lane is what says "and when it isn't, nothing happens here".
      const otherwise: Lane = {
        label: "Otherwise",
        ...(step.otherwise
          ? { steps: step.otherwise.steps, stops: step.otherwise.terminates }
          : { body: <Note>Nothing happens.</Note> }),
      };
      return <Fork head={head} lanes={[...arms, otherwise]} />;
    }

    case "race": {
      const lanes: Lane[] = step.branches.map((branch, index) => {
        // A lane that is only a NAME runs that movement — its body is that
        // movement's own story, so the lane shows the name and nothing else.
        if (branch.arm !== undefined) {
          return {
            label: <Alias name={branch.arm} />,
            steps: branch.steps,
            stops: branch.terminates,
          };
        }
        const outcome = outcomeOf(branch.steps, index);
        return {
          label: outcome.label,
          steps: outcome.rest,
          stops: branch.terminates,
        };
      });
      return step.combinator === "race" ? (
        <Fork
          head={<Head>Whichever happens first</Head>}
          lanes={lanes}
          join="carries on with whichever came first"
        />
      ) : (
        <Fork
          head={<Head>All at the same time</Head>}
          lanes={lanes}
          join="carries on once every one is done"
        />
      );
    }

    case "group":
      return (
        <Frame head={<GroupHeading over={step.over} />}>
          <Spine steps={step.steps} />
        </Frame>
      );

    // An argument that is a node the author assembled needs the room a card
    // gets: it IS a record, and rendering it as nothing was how "Runs the steps
    // in notify." came to hide everything notify was told.
    case "call":
      return <CallStep step={step} />;

    case "delete":
      return (
        <StepCard
          signpost="Removes"
          icon={<Trash2 size={13} />}
          sentence={
            <>
              Removes <BoundName name={step.subject.name} />.
            </>
          }
        />
      );

    case "refresh":
      return (
        <StepCard
          signpost="Re-reads"
          icon={<RefreshCw size={13} />}
          sentence={
            <>
              Re-reads <BoundName name={step.subject.name} /> for its latest details.
            </>
          }
        />
      );

    // What it stops FOR is the message, and a message is a value like any
    // other — so it sits in the well every value sits in, under the signpost,
    // rather than trailing off the end of a line of chrome.
    case "error":
      return (
        <StepCard
          signpost="Stops here"
          icon={<OctagonX size={13} />}
          sentence="Nothing below this runs. It says:"
        >
          <ValueChip chip={step.message} />
        </StepCard>
      );

    // A worked-out value. The PROMPT is the whole content of an AI one, so it
    // gets the room and the separation a content well gives it; the name the
    // script binds sits in the eyebrow, where a write card carries its own.
    case "value": {
      const ai = step.value.role === "ai";
      return (
        <StepCard
          signpost={ai ? "AI" : "Value"}
          icon={ai ? <Sparkles size={13} /> : <Variable size={13} />}
          tone={ai ? "ai" : "plain"}
          alias={<Alias name={step.binding} />}
          sentence={ai ? "Works this out at the time:" : "Works this out:"}
        >
          <ValueChip chip={step.value} labelled={false} />
        </StepCard>
      );
    }

    // A node the author assembled and named. The name is the script's, not a
    // word — so the card says what happened and carries the name beside it.
    case "node":
      return (
        <NodeCard
          title="What it puts together"
          signpost={{ label: "Details", icon: <Layers size={13} /> }}
          alias={step.binding}
          node={step.node}
        />
      );

    // Something a person can act on later, and the steps that run when they do.
    // It used to read "VALUE — Sets this aside for later", which said nothing
    // about the one thing it is: a button or a link with work behind it.
    case "callback":
      return <CallbackStep step={step} />;

    // A collection op can say what it did and what it did it to without
    // opening its function — so it does, rather than reading as an anonymous
    // value the reader has to go and look up.
    case "bind":
      return step.op !== undefined && step.over !== undefined ? (
        <StepCard
          signpost="Value"
          icon={<Variable size={13} />}
          alias={<Alias name={step.binding} />}
          sentence={COLLECTION_SENTENCE[step.op]}
        >
          <ValueChip chip={step.over} labelled={false} />
        </StepCard>
      ) : (
        <StepCard
          signpost="Value"
          icon={<Variable size={13} />}
          alias={<Alias name={step.binding} />}
          sentence="Sets this aside for later."
        />
      );

    // The value this body hands back — to whoever bound the block, call, or
    // closure it belongs to.
    case "return":
      return step.value ? (
        <StepCard
          signpost="Value"
          icon={<Variable size={13} />}
          sentence="Hands this back:"
        >
          <ValueChip chip={step.value} labelled={false} />
        </StepCard>
      ) : (
        <StepCard
          signpost="Value"
          icon={<Variable size={13} />}
          sentence="Hands its result back."
        />
      );

    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}

/**
 * A call: the movement it runs, and what it hands over.
 *
 * The sentence is the point of the redline. It used to read "Runs the steps in
 * toAttio with src as set out below ." — which named the callee's private
 * parameter, described the card underneath instead of letting it speak, and
 * pointed at nothing. It now names the movement as a LINK, and ends on a colon
 * where a card follows, so the sentence and the card are one utterance.
 *
 * A call whose result is BOUND is an introduction site like any other — the
 * name it binds is where `a` in a chip elsewhere comes from — so it carries the
 * same leak-only alias a for-each or a node binding does. Same rule, not a
 * special case: `Alias` shows nothing unless the name is actually on screen raw
 * somewhere, so a result nobody reads back adds no shorthand to the picture.
 *
 */
function CallStep({ step }: { step: Extract<Step, { kind: "call" }> }) {
  const movements = useContext(Movements);
  const callee = movements.get(step.movement);
  const assembled = step.args.filter(
    (arg): arg is Extract<StoryArg, { kind: "node" }> => arg.kind === "node",
  );
  const inline = step.args.filter((arg) => arg.kind !== "node");

  const sentence = (
    <>
      Runs <MovementLink name={step.movement} known={step.isMovement} />
      <Alias name={step.binding} />
      {inline.length > 0 && (
        <>
          {" with "}
          {inline.map((arg, index) => (
            <Fragment key={arg.name}>
              {index > 0 && (index === inline.length - 1 ? " and " : ", ")}
              <ArgValue arg={arg} />
              {/* Which value fills which parameter only matters when there is
                  more than one to tell apart. */}
              {step.args.length > 1 && <AliasChip name={arg.name} />}
            </Fragment>
          ))}
        </>
      )}
      {/* A sentence that ends on a CHIP takes no full stop: the chip is its own
          terminator, and a stop after one sits a hair away from it — which is
          all "as set out below ." ever was. */}
      {step.isMovement
        ? assembled.length > 0 && (inline.length > 0 ? ", and:" : " with:")
        : " — but nothing here goes by that name."}
    </>
  );

  if (assembled.length === 0) return <Plain>{sentence}</Plain>;
  return (
    <Frame head={sentence}>
      <div className="flex w-full flex-col items-center gap-2">
        {assembled.map((arg) => (
          <ArgumentCard
            key={arg.name}
            arg={arg}
            param={callee?.params.find((param) => param.name === arg.name)}
          />
        ))}
      </div>
    </Frame>
  );
}

/**
 * A DEFERRED ACTION, as a card in the anatomy every other step wears: what it
 * is in the eyebrow, the name the script gave it beside that, the sentence, and
 * then — because the steps inside are the whole point of it — those steps in a
 * frame of their own, the same one a call's callee gets.
 *
 * The alias follows the ordinary leak-only rule. It shows up in practice
 * because the id has to be carried by whatever a person actually presses, and
 * that payload is written by hand: the name is on screen in the author's own
 * JSON, so the introduction site anchors it.
 *
 */
function CallbackStep({ step }: { step: Extract<Step, { kind: "callback" }> }) {
  const movements = useContext(Movements);
  return (
    <StepCard
      signpost="When used"
      icon={<MousePointerClick size={13} />}
      alias={<Alias name={step.binding} />}
      sentence={
        step.movement !== undefined ? (
          <>
            Sets up an action somebody can take — a button to press, or a link to
            open. Taking it runs{" "}
            <MovementLink name={step.movement} known={movements.has(step.movement)} />.
          </>
        ) : step.steps.length > 0 ? (
          "Sets up an action somebody can take — a button to press, or a link to open."
        ) : (
          "Sets up an action somebody can take — a button to press, or a link to open. Nothing runs when they do."
        )
      }
    >
      {step.steps.length > 0 && (
        <Frame head={<>What happens when they do</>}>
          <Spine steps={step.steps} />
        </Frame>
      )}
    </StepCard>
  );
}

/**
 * A traversal block's heading — and, where the walk carries on from a RACE, the
 * branch it actually is.
 *
 * `r-[:timeout]->` read "With the timeout that came back", which is true of any
 * walk off any result and says nothing about the fact that these steps run only
 * if that contender won. Held against the race, the edge names one of its
 * contenders, and the contender says what happened.
 *
 */
function GroupHeading({ over }: { over: Extract<Step, { kind: "group" }>["over"] }) {
  const races = useContext(Races);
  const root = over.root?.name;
  const edge = over.hops[0]?.edge;
  const race = root !== undefined ? races.get(root) : undefined;
  if (race === undefined || edge === undefined) return <TraversalHeading id={over.id} />;
  return (
    <TraversalHeading
      id={over.id}
      lead={<>If {wonPhrase(contenderNamed(race, edge), edge)}</>}
    />
  );
}

/**
 * What it means for this contender to have won, said the way the lane above it
 * is said — the same reading of the same step, so the branch and the lane
 * cannot disagree. A contender this receipt cannot be matched to (an unnamed
 * one) falls back to the edge, which is the author's own word for it.
 */
function wonPhrase(contender: Step | undefined, edge: string): React.ReactNode {
  if (contender?.kind === "ask") return "you answered";
  if (contender?.kind === "wait") {
    const { wait } = contender;
    if (wait.kind === "sleep") return "time ran out";
    if (wait.kind === "until") return "it came to be true";
    if (wait.origin?.kind === "callback") {
      return <>somebody used<AliasChip name={wait.origin.name} /></>;
    }
  }
  return `${edge} came back`;
}

function waitSentence(wait: Extract<Step, { kind: "wait" }>["wait"]): React.ReactNode {
  if (wait.kind === "sleep") return <>Waits {wait.duration} before carrying on.</>;
  if (wait.kind === "until") {
    return (
      <>
        Waits until {wait.condition ? <ValueChip chip={wait.condition} /> : "it is time"}
        {wait.every ? <>, checking every {wait.every}</> : null}.
      </>
    );
  }
  // Waiting on a deferred action is waiting on a person, and the action has a
  // name; "Waits for Called to come back" is the language's word for the edge.
  if (wait.origin?.kind === "callback") {
    return <>Waits until somebody uses<AliasChip name={wait.origin.name} />.</>;
  }
  return <>Waits for {wait.edge ?? "something"} to come back.</>;
}

/**
 * A race lane is named by its OUTCOME, and that outcome is the step the lane
 * waits on — so it moves up into the label rather than being drawn twice.
 *
 * Two lanes waiting on two different deferred actions both read "Called comes
 * back", because the EDGE is all a wait used to carry — one label for two
 * different things, which names neither. What tells them apart is what each
 * waits ON, so that is what the label says.
 *
 */
function outcomeOf(
  steps: Step[],
  index: number,
): { label: React.ReactNode; rest: Step[] } {
  const [first, ...rest] = steps;
  if (first?.kind === "ask") return { label: "You answer", rest };
  if (first?.kind === "wait") {
    const { wait } = first;
    if (wait.kind === "sleep") return { label: `${wait.duration} passes`, rest };
    if (wait.kind === "until") {
      return {
        label: wait.condition ? <>Until <ValueChip chip={wait.condition} /></> : "It is time",
        rest,
      };
    }
    if (wait.origin?.kind === "callback") {
      return {
        label: <>Somebody uses<AliasChip name={wait.origin.name} /></>,
        rest,
      };
    }
    return { label: `${wait.edge ?? "Something"} comes back`, rest };
  }
  return { label: `Option ${index + 1}`, rest: steps };
}

function endsInError(steps: Step[] | undefined): boolean {
  return steps !== undefined && steps[steps.length - 1]?.kind === "error";
}

/** An argument that fits in the sentence. An assembled node does not — it is
 *  drawn as its own card below. */
function ArgValue({ arg }: { arg: StoryArg }) {
  switch (arg.kind) {
    case "value":
      return <ValueChip chip={arg.chip} />;
    case "node":
      return <>what is set out below</>;
    case "record":
      return <WrittenRecord id={arg.record} />;
    case "call":
      return (
        <>
          what <MovementLink name={arg.movement} /> comes back with
        </>
      );
  }
}

// ── Small parts ─────────────────────────────────────────────────────────────

/** Which independent story this column is, when there is more than one to tell
 *  apart — a file with a single story needs no name, so this never shows in the
 *  common case and the demo file's canvas stays unchanged. */
function SectionName({ children }: { children: React.ReactNode }) {
  return (
    <span {...readable("mb-1.5 text-[12px] font-medium text-gray-500")}>{children}</span>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <span {...readable("mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-gray-400")}>
      {children}
    </span>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <span {...readable(`${NODE_MAX} border border-gray-200 bg-white px-3 py-1.5 text-center text-[12px] text-gray-600 [overflow-wrap:anywhere] ${BOX} ${LIFT}`)}>
      {children}
    </span>
  );
}

/** Lane labels carry conditions, and a condition is the whole point of the
 *  lane — so a long one wraps rather than being cut off, and breaks INSIDE a
 *  long unbroken run rather than forcing its lane wider. */
function LaneLabel({ children }: { children: React.ReactNode }) {
  return (
    <span {...readable(`${NODE_MAX} border border-gray-200 bg-white px-2.5 py-[3px] text-center text-[11px] text-gray-500 [overflow-wrap:anywhere] ${BOX} ${LIFT}`)}>
      {children}
    </span>
  );
}

function JoinLabel({ children }: { children: React.ReactNode }) {
  return (
    <span {...readable(`${NODE_MAX} text-center text-[11px] text-gray-400`)}>{children}</span>
  );
}

function TerminalCap() {
  return (
    <span {...readable(`border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-400 ${BOX} ${LIFT}`)}>
      Stops here
    </span>
  );
}

/** Where a run finishes on its own. Quiet on purpose — it is the absence of
 *  anything more, not an event — and worded as the reader would say it rather
 *  than as the thing that stopped ("terminates", "end of flow"). */
function EndCap() {
  return (
    <span
      {...readable(`flex items-center gap-1.5 border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-400 ${BOX} ${LIFT}`)}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gray-300" />
      All done
    </span>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <span {...readable("text-[11.5px] text-gray-400")}>{children}</span>;
}

/** A step with nothing to show but its sentence. */
function Plain({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span {...readable(`flex w-full min-w-0 ${NODE_MAX} items-baseline gap-1.5 border border-gray-200 bg-white px-3.5 py-2.5 text-[12px] leading-relaxed text-gray-700 ${BOX} ${LIFT}`)}>
      {icon && <span className="shrink-0 translate-y-[2px]">{icon}</span>}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </span>
  );
}

/**
 * A pause: everything below it waits.
 *
 * It is a node like the rest — as wide as what it says and no wider (Redline
 * 15). It used to span the column on the theory that a cut has to reach
 * both edges to be a cut, but the column has no edges of its own to reach: it
 * is only as wide as the widest thing in it, so "full width" meant whatever a
 * fork three steps down happened to need. What says pause is the amber and the
 * held icon, and those say it at any width.
 *
 * The sentence still caps where every node does, or one line of prose would
 * decide how wide the whole story is drawn.
 *
 */
function Bar({
  tone,
  icon,
  children,
}: {
  tone: "pause" | "quiet";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      {...readable(
        `flex min-w-0 items-center gap-2 border px-3.5 py-2 text-[12px] ${BOX} ${LIFT} ${
          tone === "pause"
            ? "border-amber-200 bg-amber-50 text-amber-800"
            : "border-gray-200 bg-white text-gray-500"
        }`,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className={`min-w-0 ${NODE_MAX} [overflow-wrap:anywhere]`}>{children}</span>
    </span>
  );
}

/**
 * A frame: the same thing, many times. One way in, one way out — never lanes,
 * which would read as "different things happen".
 *
 * A frame HUGS what is in it. It is a box drawn around some contents, so its
 * width is those contents' width — never the column's, which is a different
 * question with a different answer: a column is as wide as the WIDEST thing in
 * it, so a fork lower down could make an extraction three times the width of
 * the tree inside it and leave the tree marooned in its own rectangle. Hugging
 * is what a box around something means, and it is now what every frame does
 * rather than a flag one caller passed.
 *
 * Centring costs nothing and needs no measurement: the spine centres its
 * children, so a frame narrower than the spine sits on the spine, and what it
 * holds is centred within it — the two centres are the same line, at any width.
 * Everything on the spine sits this way now, the ask cut included (see `Bar`).
 *
 * The head is a SENTENCE, so it is laid out as running text. It used to be a
 * flex row, which made every run of words between two chips its own flex item
 * and spaced them apart — that is where "as set out below ." got its space
 * before the full stop. Chips are inline, and flow in a sentence unaided.
 *
 */
function Frame({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className={`w-auto max-w-full border border-dashed border-gray-300 bg-white/60 p-3 ${BOX} ${LIFT}`}
    >
      {/* The head caps where every node does, so a long sentence wraps instead
          of setting how wide the frame — and with it the column — is drawn. The
          frame itself is free to be wider than that when what it holds is. */}
      <div
        {...readable(`mb-2 ${NODE_MAX} text-[11.5px] leading-[19px] text-gray-500 [overflow-wrap:anywhere]`)}
      >
        {head}
      </div>
      <div className="flex flex-col items-center">{children}</div>
    </div>
  );
}
