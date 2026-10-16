"use client";

// Hidden, URL-only adapter type-graph explorer. Pick a connected instance,
// stand on its connection node, and walk — one hop per call, the SAME
// `describeConnection` walk the authoring agent makes. Nothing loads a graph:
// what you see is exactly what an agent standing here would see, which is the
// whole point of the page. Promises — read / write / fires — belong to EDGES,
// never nodes; a node carries only its name, properties, and edges.

import { useState } from "react";
import { neverAsAny, variantOf } from "movement-lang";
import type { FieldType } from "movement-lang";
import { trpc } from "@/lib/trpc";

type Instance = {
  adapterType: string;
  displayName: string;
  credential: { id: string; name: string; type: string } | null;
  remote: boolean;
};

type WalkedProperty = {
  type: FieldType;
  readable: boolean;
  writable: boolean;
  required: boolean;
  description?: string;
};

// A landing is either described or a STUB. A stub is NOT a node with no
// fields — it is a node whose fields cost one hop, and it says so.
type WalkedNodeShape =
  | { name: string; description?: string; properties: Record<string, WalkedProperty>; stub?: false }
  | { name: string; description?: string; stub: true; hint: string };

type WalkedEdge = {
  name: string;
  description?: string;
  cardinality: "one" | "many";
  readable: boolean;
  writable: boolean;
  fires?: true;
  firesOn?: string[];
  ephemeral?: true;
  position?: string;
  members?: { name: string; position: string }[];
  narrowBy?: string[];
  target?: WalkedNodeShape;
};

type WalkedNode = {
  position: string;
  name: string;
  description?: string;
  properties: Record<string, WalkedProperty>;
  edges: WalkedEdge[];
};

type Hop = { node?: WalkedNode; note?: string; footnote?: string; elapsedMs: number };

/** One step of the address, kept as it was walked. The label comes off the edge
 *  that handed the position over — never parsed back out of the string, which
 *  would be reading a magic string where an identity is meant. */
type Step = { label: string; position: string };

const chipClass: Record<string, string> = {
  read: "bg-emerald-100 text-emerald-800",
  write: "bg-amber-100 text-amber-800",
  fires: "bg-violet-100 text-violet-800",
  eph: "bg-gray-100 text-gray-600",
  none: "bg-gray-100 text-gray-500",
  stub: "bg-sky-100 text-sky-800",
};

function Chip({ kind, label }: { kind: string; label: string }) {
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${chipClass[kind] ?? chipClass.none}`}>
      {label}
    </span>
  );
}

// Parenthesised when a union, as TypeScript writes `(string | number)[]`.
function typeMember(t: FieldType): string {
  const name = typeName(t);
  return variantOf(t).kind === "union" ? `(${name})` : name;
}

function typeName(t: FieldType): string {
  const v = variantOf(t);
  switch (v.kind) {
    case "text":
    case "number":
    case "boolean":
    case "date":
    case "datetime":
    case "file":
    // A structured value, opaque to everything but another json field.
    case "json":
    case "absent":
    case "never":
      return v.kind;
    case "list":
      return `${typeMember(v.of)}[]`;
    case "enum":
      return v.open ? "enum (open)" : "enum";
    case "tuple":
      return `[${v.of.map((slot) => (slot === null ? "?" : typeName(slot))).join(", ")}]`;
    case "dict":
      return `{${typeName(v.of)}}`;
    case "maybeAbsent":
      return `${typeMember(v.of)}?`;
    case "union":
      return v.of.map(typeName).join(" | ");
    case "record":
      return "record";
    default:
      return neverAsAny(v);
  }
}

function enumOptions(t: FieldType): string[] {
  const v = variantOf(t);
  switch (v.kind) {
    case "enum":
      return v.options;
    // A collection's options are its element's — the chip row lists what a
    // single value may be, whatever wraps it.
    case "list":
    case "dict":
    case "maybeAbsent":
      return enumOptions(v.of);
    // A union's options are its members' together, each listed once.
    case "union":
      return [...new Set(v.of.flatMap(enumOptions))];
    case "text":
    case "number":
    case "boolean":
    case "date":
    case "datetime":
    case "file":
    case "json":
    case "absent":
    case "never":
    case "tuple":
    case "record":
      return [];
    default:
      return neverAsAny(v);
  }
}

function EdgePromises({ e }: { e: WalkedEdge }) {
  const any = e.fires || e.readable || e.writable;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {e.fires && <Chip kind="fires" label="fires" />}
      {e.readable && <Chip kind="read" label="read" />}
      {e.writable && <Chip kind="write" label="write" />}
      {e.ephemeral && <Chip kind="eph" label="ephemeral" />}
      {!any && <Chip kind="none" label="no promises" />}
    </span>
  );
}

export default function GraphExplorerPage() {
  // Team selector is a DEV affordance (any team by id, non-prod only). undefined
  // = the caller's own team; the router defaults to it and refuses cross-team in
  // production.
  const { data: teams } = trpc.views.graphExplorer.listTeams.useQuery();
  const [teamId, setTeamId] = useState<string | undefined>(undefined);

  const { data: instances, isLoading: loadingList } = trpc.views.graphExplorer.listInstances.useQuery(
    teamId ? { teamId } : {},
    { refetchOnWindowFocus: false },
  );
  const [selected, setSelected] = useState<Instance | null>(null);
  // The address, kept as walked. Empty = standing on the connection node.
  const [trail, setTrail] = useState<Step[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const position = trail.length > 0 ? trail[trail.length - 1]!.position : "";

  const hopQuery = trpc.views.graphExplorer.walk.useQuery(
    selected
      ? {
          adapterType: selected.adapterType,
          ...(selected.credential ? { credentialsId: selected.credential.id } : {}),
          ...(position ? { position } : {}),
          ...(refreshKey > 0 ? { forceRefresh: true } : {}),
          ...(teamId ? { teamId } : {}),
        }
      : { adapterType: "" },
    { enabled: !!selected, refetchOnWindowFocus: false },
  );
  const hop = hopQuery.data as Hop | undefined;
  const node = hop?.node;

  const pick = (inst: Instance) => {
    setSelected(inst);
    setTrail([]);
    setRefreshKey(0);
  };

  const changeTeam = (id: string) => {
    setTeamId(id || undefined); // "" (the default option) = the caller's own team
    setSelected(null);
    setTrail([]);
    setRefreshKey(0);
  };

  const walkTo = (step: Step) => setTrail([...trail, step]);

  // The edge you ARRIVED along — the only incoming edge that is a fact rather
  // than a whole-graph inference. Standing at the root there is none.
  const arrivedAlong = trail.length > 0 ? trail[trail.length - 1]!.label : null;

  return (
    <div className="flex h-full min-h-0 gap-4 p-4">
      {/* Instance picker */}
      <aside className="w-56 shrink-0 overflow-y-auto">
        {/* Team selector — a dev affordance (any team by id, non-prod only). */}
        {teams && teams.length > 1 && (
          <div className="mb-3">
            <label className="mb-1 block text-[11px] font-medium text-gray-400">Team (dev)</label>
            <select
              value={teamId ?? ""}
              onChange={(e) => changeTeam(e.target.value)}
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[12px] focus:border-gray-400 focus:outline-none"
            >
              <option value="">My team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name || t.id}
                </option>
              ))}
            </select>
          </div>
        )}
        <h2 className="mb-2 text-[13px] font-semibold text-gray-700">Instances</h2>
        {loadingList && <p className="text-[12px] text-gray-400">Loading…</p>}
        <ul className="space-y-1">
          {(instances ?? []).map((inst) => (
            <li key={`${inst.adapterType}:${inst.credential?.id ?? "none"}`}>
              <button
                onClick={() => pick(inst)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                  selected?.adapterType === inst.adapterType
                    ? "bg-primary text-white"
                    : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                <div className="font-medium">{inst.displayName}</div>
                <div className={`text-[10px] ${selected?.adapterType === inst.adapterType ? "text-white/70" : "text-gray-400"}`}>
                  {inst.adapterType}
                  {inst.remote ? " · remote" : ""}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Stage */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {!selected && <p className="text-[13px] text-gray-400">Pick an instance to explore its type graph.</p>}
        {selected && hopQuery.isLoading && <p className="text-[13px] text-gray-400">Walking {selected.displayName}…</p>}

        {selected && hop && (
          <>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] text-gray-500">
                {selected.credential ? `${selected.credential.name} (${selected.credential.type})` : "credential-free"}
                {node ? ` · ${Object.keys(node.properties).length} properties · ${node.edges.length} edges` : ""}
                {` · ${hop.elapsedMs}ms · one hop`}
              </p>
              <button
                onClick={() => setRefreshKey((k) => k + 1)}
                disabled={hopQuery.isFetching}
                className="rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {hopQuery.isFetching ? "Refreshing…" : "Refresh"}
              </button>
            </div>

            {hop.note && (
              <div className="mb-2 rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">{hop.note}</div>
            )}

            {/* Breadcrumb — the address, as walked */}
            <div className="mb-3 flex flex-wrap items-center gap-1 text-[12px]">
              <button onClick={() => setTrail([])} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono hover:bg-gray-200">
                {selected.adapterType}
              </button>
              {trail.map((step, i) => (
                <button
                  key={i}
                  onClick={() => setTrail(trail.slice(0, i + 1))}
                  className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-600 hover:bg-gray-200"
                >
                  -[:{step.label}]&gt;
                </button>
              ))}
            </div>

            {node && (
              <>
                <HopHonesty node={node} />

                <div className="rounded-lg border border-gray-200 bg-white p-4">
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="text-[15px] font-semibold text-gray-900">{node.name}</h3>
                    {trail.length === 0 && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">connection</span>
                    )}
                  </div>
                  {arrivedAlong && (
                    <div className="mb-1 text-[11px] text-gray-400">
                      arrived along <span className="font-mono">-[:{arrivedAlong}]&gt;</span>
                    </div>
                  )}
                  {node.description && (
                    <div className="mb-2 rounded bg-gray-50 px-2 py-1 text-[11px] text-gray-600">{node.description}</div>
                  )}

                  <Properties properties={node.properties} />

                  <div className="mb-1 text-[12px] font-semibold text-gray-700">Edges out ({node.edges.length})</div>
                  <div className="space-y-1">
                    {node.edges.length === 0 && (
                      <p className="text-[12px] text-gray-400">No outgoing edges — the walk ends here.</p>
                    )}
                    {node.edges.map((e, i) => (
                      <Edge key={i} edge={e} onWalk={walkTo} />
                    ))}
                  </div>
                </div>
              </>
            )}

            {hop.footnote && <p className="mt-3 text-[11px] text-gray-400">{hop.footnote}</p>}
          </>
        )}
      </main>
    </div>
  );
}

function Properties({ properties }: { properties: Record<string, WalkedProperty> }) {
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return <p className="mb-3 text-[12px] text-gray-400">Described, and honestly property-less: zero properties.</p>;
  }
  return (
    <table className="mb-3 w-full text-[12px]">
      <thead>
        <tr className="text-left text-gray-400">
          <th className="py-1 font-medium">Property</th>
          <th className="py-1 font-medium">Type</th>
          <th className="py-1 font-medium">Promises</th>
          <th className="py-1 font-medium">Values / description</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([name, p]) => {
          const options = enumOptions(p.type);
          return (
            <tr key={name} className="border-t border-gray-100 align-top">
              <td className="py-1 pr-2">
                {name}
                {p.required ? " *" : ""}
              </td>
              <td className="py-1 pr-2 font-mono text-gray-500">{typeName(p.type)}</td>
              <td className="py-1 pr-2">
                {p.readable && <Chip kind="read" label="read" />} {p.writable && <Chip kind="write" label="write" />}
                {!p.readable && !p.writable && <Chip kind="none" label="none" />}
              </td>
              <td className="py-1 text-gray-500">{options.length > 0 ? options.join(" | ") : (p.description ?? "")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Edge({ edge, onWalk }: { edge: WalkedEdge; onWalk: (step: Step) => void }) {
  const dotted = !edge.readable && !edge.fires;
  const stubbed = edge.target?.stub === true;
  const walkable = edge.position !== undefined;

  return (
    <div className={`rounded-md border px-2 py-1.5 ${dotted ? "border-dashed border-gray-300" : "border-gray-200"}`}>
      <button
        disabled={!walkable}
        onClick={() => walkable && onWalk({ label: edge.name, position: edge.position! })}
        className="flex w-full flex-wrap items-center gap-2 text-left text-[12px] enabled:hover:opacity-70 disabled:cursor-default"
      >
        <span className="font-mono">-[:{edge.name}]&gt;</span>
        <EdgePromises e={edge} />
        <span className="text-gray-400">
          → {edge.target?.name ?? "unknown"}
          {edge.cardinality === "many" ? " (many)" : ""}
        </span>
        {/* A stub's fields exist and cost one hop. The badge is the whole
            statement — the address is already the thing you click. */}
        {stubbed && <Chip kind="stub" label="stub" />}
      </button>

      {edge.description && <div className="mt-0.5 text-[11px] text-gray-400">{edge.description}</div>}
      {edge.firesOn && edge.firesOn.length > 0 && (
        <div className="mt-0.5 text-[11px] text-gray-400">fires on: {edge.firesOn.join(", ")}</div>
      )}

      {/* Why an edge has no address is TWO different facts, and saying the
          wrong one is worse than saying nothing. An event has no address
          because it does not exist until it fires — that is the model, not a
          gap. Anything else is reachable by name but not by walking. */}
      {!walkable && !edge.members?.length && (
        <div className="mt-1 text-[11px] text-gray-400">
          {edge.fires
            ? "Delivered to a listener when it fires — you don't walk to an event."
            : "No address — this edge is real, but it is reached by name, not by walking."}
        </div>
      )}

      {/* A polymorphic edge is ONE edge with MANY members. Narrowing to a member
          is how you walk it — the members carry the addresses, the edge has none. */}
      {edge.members && edge.members.length > 0 && (
        <div className="mt-1.5">
          <div className="mb-1 text-[11px] text-gray-500">
            Narrow to a member ({edge.members.length})
            {edge.narrowBy && edge.narrowBy.length > 0 && (
              <>
                {" · a "}
                <span className="font-mono">WHERE</span> may test: {edge.narrowBy.join(", ")}
              </>
            )}
          </div>
          <div className="space-y-1">
            {edge.members.map((m, i) => (
              <button
                key={i}
                onClick={() => onWalk({ label: `${edge.name} WHERE == "${m.name}"`, position: m.position })}
                className="flex w-full items-center gap-2 rounded-md border-l-[3px] border-primary bg-gray-50 px-2 py-1 text-left text-[12px] hover:bg-gray-100"
              >
                <span className="font-mono text-primary">WHERE == &quot;{m.name}&quot;</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Honesty facts about THIS hop — the only ones that are facts. Whole-graph
 * checks (orphans, entry-list-vs-walk mismatches) died with the second walker
 * that computed them; there is no second claim left to cross-check.
 */
function HopHonesty({ node }: { node: WalkedNode }) {
  const writeOnly = node.edges.filter((e) => e.writable && !e.readable && !e.fires).map((e) => e.name);
  const unwalkable = node.edges.filter((e) => e.position === undefined && !e.members?.length).map((e) => e.name);
  const stubs = node.edges.filter((e) => e.target?.stub === true).map((e) => e.target!.name);
  const unknownLanding = node.edges.filter((e) => e.target === undefined).map((e) => e.name);
  // An edge a movement can do nothing with — not readable, not writable, not
  // delivered, and with no members whose promises it stands in for. The last
  // two exceptions are the point: an event edge and a polymorphic edge both
  // look empty to a read/write test and are neither.
  const promiseless = node.edges
    .filter((e) => !e.readable && !e.writable && !e.fires && !e.members?.length)
    .map((e) => e.name);

  const groups: [string, string[]][] = [
    ["promises nothing", promiseless],
    ["write-only edges", writeOnly],
    ["no address", unwalkable],
    ["stubbed landings", stubs],
    ["landing unstated", unknownLanding],
  ];
  const active = groups.filter(([, v]) => v.length > 0);
  const [open, setOpen] = useState<string | null>(null);
  if (active.length === 0) return null;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap gap-1">
        {active.map(([label, v]) => (
          <button
            key={label}
            onClick={() => setOpen(open === label ? null : label)}
            className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-200"
          >
            {label}: {v.length}
          </button>
        ))}
      </div>
      {open && (
        <ul className="mt-1 list-inside list-disc rounded bg-gray-50 px-3 py-2 text-[11px] text-gray-600">
          {(active.find(([l]) => l === open)?.[1] ?? []).map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
