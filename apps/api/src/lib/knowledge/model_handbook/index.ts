// The knowledge-model design handbook — chapters teaching how to shape,
// identify, relate, and evolve the knowledge model. Mirrors the
// movement_handbook registry pattern: consumer-neutral chapter bodies
// (the same text can serve a design agent's reference tool and the
// Library reader) behind a thin index/lookup surface.
//
// Seeded from the teaching content the ontology assistant works from
// (lib/knowledge/ontology_agent.ts), rewritten for a reader designing
// their own model.

import type { Handbook, ChapterId, Chapter, IntentEntry } from './types';

import { shape } from './chapters/shape';
import { identity } from './chapters/identity';
import { relationships } from './chapters/relationships';
import { editing } from './chapters/editing';

const PREFACE = `## What the knowledge model is

The knowledge model is the structure behind everything Listen-Fire tracks:
the kinds of things you care about (entity types), the information
recorded on each (fields), and how they connect (relationships). It
frames every answer, every extraction from an inbound message, and
every sync to another tool. These chapters cover how to design that
structure and how to change it safely once it's live.`;

const CONVENTIONS = `## Conventions (always in play)

- Entity types are singular, title case: "Company", not "companies".
- Every relationship has two names — one reading from each end.
- Facts about a connection live on the relationship, not on either entity.
- Every entity type gets identity rules, set after its fields and
  relationships exist.`;

const INTENT_INDEX: IntentEntry[] = [
  { intent: 'Decide what should be a type, a field, or a relationship', chapter: 'shape' },
  { intent: 'Stop repeat mentions creating duplicate entries', chapter: 'identity' },
  { intent: 'Two different things share the same name', chapter: 'identity' },
  { intent: 'Record a fact about a connection (a role, an amount)', chapter: 'relationships' },
  { intent: 'One entity type plays several distinct roles', chapter: 'relationships' },
  { intent: 'Add to or restructure a model that already holds data', chapter: 'editing' },
  { intent: 'Understand what a delete takes with it', chapter: 'editing' },
];

const CHAPTERS: Record<ChapterId, Chapter> = {
  shape,
  identity,
  relationships,
  editing,
};

export const modelHandbook: Handbook = {
  preface: PREFACE,
  conventions: CONVENTIONS,
  intentIndex: INTENT_INDEX,
  chapters: CHAPTERS,
};
