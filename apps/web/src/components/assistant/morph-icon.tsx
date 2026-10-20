"use client";

/**
 * The assistant's animated identity: the product mark, which morphs into a
 * filled speech bubble while hovered/focused — the mark becomes a
 * conversation". Used on the corner launcher; static surfaces keep the
 * mark-in-bubble `AssistantIcon`.
 *
 * Morph technique: the mark (three subpaths) and the
 * bubble (one path of arcs) have incompatible structures, so the `d`
 * attribute cannot be tweened directly. Both outlines are resampled
 * once into fixed-length point lists (`getPointAtLength` on a hidden
 * measuring SVG), rotation-aligned so corresponding points travel
 * minimal distance, then lerped per frame. The mark's two smaller parts
 * shrink into themselves over the first 60% while the body morphs.
 * At rest (t = 0 or 1) the TRUE paths render, so the polygon
 * approximation is only ever visible mid-flight.
 *
 * Reduced motion: the icon swaps states instantly, no tween.
 */

import { useEffect, useRef, useState } from "react";
import { LISTEN_FIRE_MARK_PATHS } from "@/components/icons";

const MARK_BODY = LISTEN_FIRE_MARK_PATHS.slabMiddle;
const MARK_PART_TOP = LISTEN_FIRE_MARK_PATHS.slabLeft;
const MARK_PART_BOTTOM = LISTEN_FIRE_MARK_PATHS.slabRight;
// Mark placement, centred on the 24×24 icon box. At 1.5× the bubble's
// footprint (~31px) it deliberately overflows the viewBox — the svg
// renders overflow-visible, and inside the 48px launcher there's room —
// then shrinks into the bubble on morph.
const MARK_SCALE = 0.1575;
const MARK_TX = 12 - 100 * MARK_SCALE;
const MARK_TY = 12 - 98 * MARK_SCALE;
// Filled speech bubble in icon space.
const BUBBLE_D =
  "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";

const N_BODY = 200;
const N_SPIKE = 64;
const DURATION_MS = 200;

type Pt = [number, number];

type MorphGeometry = {
  body: Pt[]; // mark body, aligned to bubble point order
  bubble: Pt[];
  spikes: { points: Pt[]; centroid: Pt }[];
};

function samplePath(
  d: string,
  n: number,
  map: (x: number, y: number) => Pt,
): Pt[] {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  // Attached but invisible — Safari measures detached paths unreliably.
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  document.body.appendChild(svg);
  try {
    const len = path.getTotalLength();
    const pts: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const p = path.getPointAtLength((len * i) / n);
      pts.push(map(p.x, p.y));
    }
    return pts;
  } finally {
    svg.remove();
  }
}

/** Rotate `src` so its index 0 best lines up with `dst`'s index 0. */
function alignRotation(src: Pt[], dst: Pt[]): Pt[] {
  let best = 0;
  let bestD = Infinity;
  for (let offset = 0; offset < src.length; offset++) {
    let d = 0;
    for (let i = 0; i < src.length; i += 8) {
      const a = src[(i + offset) % src.length];
      const b = dst[i];
      d += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    }
    if (d < bestD) {
      bestD = d;
      best = offset;
    }
  }
  return src.map((_, i) => src[(i + best) % src.length]);
}

function centroidOf(pts: Pt[]): Pt {
  const sum = pts.reduce<Pt>(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
    [0, 0],
  );
  return [sum[0] / pts.length, sum[1] / pts.length];
}

function computeGeometry(): MorphGeometry {
  const markMap = (x: number, y: number): Pt => [
    x * MARK_SCALE + MARK_TX,
    y * MARK_SCALE + MARK_TY,
  ];
  const identity = (x: number, y: number): Pt => [x, y];
  const bubble = samplePath(BUBBLE_D, N_BODY, identity);
  const body = alignRotation(samplePath(MARK_BODY, N_BODY, markMap), bubble);
  const spikes = [MARK_PART_TOP, MARK_PART_BOTTOM].map((d) => {
    const points = samplePath(d, N_SPIKE, markMap);
    return { points, centroid: centroidOf(points) };
  });
  return { body, bubble, spikes };
}

function toPolygon(pts: Pt[]): string {
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `L${pts[i][0].toFixed(2)},${pts[i][1].toFixed(2)}`;
  }
  return d + "Z";
}

// Linear reads best for this morph (tried ease-in-out; at 200ms the
// slow-in made the onset feel like a hitch). Swap the body back to
// `t < 0.5 ? 2t² : 1 - (-2t + 2)² / 2` to restore ease-in-out.
function ease(t: number): number {
  return t;
}

type MorphFrame = { paths: string[]; strokeWidth: number };

// The resting mark is fattened by an 8-unit stroke (like the logo); the
// sampled points follow the unstroked skeleton. Mid-flight frames carry
// the same stroke, eased away as the body becomes the (strokeless)
// bubble — without this the first frame visibly thins the mark.
const MARK_STROKE_ICON = 8 * MARK_SCALE;

/** Mid-flight frame: morphing body + shrinking spikes. */
function buildFrame(geom: MorphGeometry, t: number): MorphFrame {
  const e = ease(t);
  const body = geom.body.map(
    (p, i): Pt => [
      p[0] + (geom.bubble[i][0] - p[0]) * e,
      p[1] + (geom.bubble[i][1] - p[1]) * e,
    ],
  );
  const paths = [toPolygon(body)];
  const spikeT = Math.min(1, t / 0.6);
  if (spikeT < 1) {
    const k = 1 - ease(spikeT);
    for (const spike of geom.spikes) {
      paths.push(
        toPolygon(
          spike.points.map(
            (p): Pt => [
              spike.centroid[0] + (p[0] - spike.centroid[0]) * k,
              spike.centroid[1] + (p[1] - spike.centroid[1]) * k,
            ],
          ),
        ),
      );
    }
  }
  return { paths, strokeWidth: MARK_STROKE_ICON * (1 - e) };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The true mark, used at rest — crisp outlines, no resampling. */
function StaticMark() {
  return (
    <g
      transform={`translate(${MARK_TX} ${MARK_TY}) scale(${MARK_SCALE})`}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="8"
      strokeLinejoin="miter"
      strokeLinecap="butt"
    >
      <path d={MARK_BODY} />
      <path d={MARK_PART_TOP} />
      <path d={MARK_PART_BOTTOM} />
    </g>
  );
}

export function MorphingAssistantIcon({
  active,
  className,
}: {
  /** true → morph to the speech bubble; false → back to the mark. */
  active: boolean;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  // Geometry needs the DOM — computed once on the client. SSR and the
  // first client render show the static mark.
  const [geom, setGeom] = useState<MorphGeometry | null>(null);
  useEffect(() => setGeom(computeGeometry()), []);

  const tRef = useRef(0);
  // "mark" / "bubble" render the true paths; a frame is mid-flight.
  const [display, setDisplay] = useState<"mark" | "bubble" | MorphFrame>(
    "mark",
  );

  useEffect(() => {
    const target = active ? 1 : 0;
    const rest = active ? ("bubble" as const) : ("mark" as const);
    if (tRef.current === target || !geom || reducedMotion) {
      tRef.current = target;
      setDisplay(rest);
      return;
    }
    let last = performance.now();
    let raf: number;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const dir = Math.sign(target - tRef.current);
      tRef.current = Math.min(
        1,
        Math.max(0, tRef.current + (dir * dt) / DURATION_MS),
      );
      if (tRef.current === target) {
        setDisplay(rest); // rest: render the true shape
        return;
      }
      setDisplay(buildFrame(geom, tRef.current));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active, geom, reducedMotion]);

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      overflow="visible"
      className={className}
    >
      {display === "mark" ? (
        <StaticMark />
      ) : display === "bubble" ? (
        <path d={BUBBLE_D} fill="currentColor" />
      ) : (
        display.paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={display.strokeWidth}
            strokeLinejoin="miter"
            strokeLinecap="butt"
          />
        ))
      )}
    </svg>
  );
}
