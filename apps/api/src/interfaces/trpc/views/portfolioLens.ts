/**
 * What a portfolio line means — two answers, and which one a caller gets is
 * its own choice.
 *
 * Under `holdings`, a line is "what I hold in this company now". Shares taken
 * in a share-for-share sale are still ours, but they are no longer a holding
 * in the company we bought into — they are a holding in the company that
 * bought it. So the value moves onto the acquirer's own line and the acquired
 * company keeps only what still tracks it, which for a clean sale is nothing
 * at all.
 *
 * Under `investment`, a line is "a company I put money into". Nothing moves:
 * the swap shares stay folded into the line for the investment that earned
 * them, and an acquirer only appears if we invested into it directly.
 *
 * The projection is arithmetic over figures the valuation already returns:
 * full retained minus retained-in-company is exactly the value that moves. It
 * creates and destroys no atom, so portfolio totals are identical under both
 * lenses — only which line carries the value moves.
 */

import { z } from 'zod';

import { neverAsAny } from 'movement-engine/lib/utils/types';

const portfolioLensSchema = z
  .enum(['investment', 'holdings'])
  .default('holdings')
  .describe(
    'Which question a line answers: under `investment` a line is a company you put money into, ' +
      'and shares taken in a share-for-share sale stay on that line; under `holdings` a line is ' +
      "what you hold now, so those shares move onto the acquirer's own line. The totals are the " +
      'same either way.',
  );

type PortfolioLens = z.infer<typeof portfolioLensSchema>;

// The acquirer as the base query left-joins it: present exactly when the
// company carries an `acquired_by_legal_entity_id`, which is the only case the
// projection ever asks for one.
interface AcquirerJoin {
  id: string | null;
  name: string | null;
  slug: string | null;
  image_url: string | null;
}

// The same acquirer once the projection has established it exists.
interface AcquirerRef {
  id: string;
  name: string;
  slug: string | null;
  image_url: string | null;
}

/**
 * What the arithmetic reads and rewrites on a row. Each surface's own row
 * object carries these alongside whatever else it displays; the projection
 * never looks at the rest.
 */
interface LensRow {
  name: string;
  legal_entity_id: string;
  acquired_by_legal_entity_id: string | null;
  acquirer: AcquirerJoin;
  // The money that went in, and the return measured against it. A line minted
  // for an acquirer we never invested into states neither.
  totalInvested: number | null;
  moic: number | null;
  retainedAll: number;
  retainedInCompany: number;
  totalValue: number;
  // "Is anything left to come on this line?" — the Status predicate, re-pointed
  // at the tracking-only question once a line's non-tracking value has moved.
  holdsRetainedAssets: boolean;
  holdsTrackingAssets: boolean;
  // True once a sale for shares has put value on this line: the marker for
  // holdings we never paid cash for, which is what makes a ratio against cash
  // meaningless here.
  carriesSwapValue: boolean;
}

// Below this, the difference between full and in-company retained is rounding
// noise rather than a holding worth a line of its own.
const MOVED_VALUE_EPSILON = 1e-9;

// A line holding shares it never paid for states no MOIC: the value came from
// somewhere else, so measuring it against this line's cash flatters it.
function statedMoic(row: LensRow): number | null {
  if (row.carriesSwapValue || !row.totalInvested) {
    return null;
  }
  return row.totalValue / row.totalInvested;
}

/**
 * Re-anchor retained value onto the entity that actually holds it.
 *
 * Invested and realised stay where they are: the money went into the company
 * we bought, and the cash came back out of it. What moves is the live holding,
 * so a minted acquirer line shows retained value with the invested column
 * blank, and the company it came out of is left reading as what it now is — a
 * position paid out in shares, with nothing of its own still held.
 *
 * Nothing is created for a company with no recorded acquirer: the value stays
 * on its investment line rather than going somewhere unnamed, which is what
 * keeps the totals invariant.
 */
function withHoldingsLens<Row extends LensRow>({
  rows,
  mergeByCompany,
  deriveAcquirerRow,
}: {
  rows: Row[];
  // Aggregating by company, several sales to the same acquirer are one holding
  // in it, merged into the acquirer's own investment line when we have one.
  // Aggregating by investment, each source investment keeps its own line: the
  // question being asked is what THIS investment is worth now.
  mergeByCompany: boolean;
  deriveAcquirerRow: (source: Row, acquirer: AcquirerRef) => Row;
}): Row[] {
  const projected: Row[] = [];
  const linesByEntity = new Map<string, Row>();

  if (mergeByCompany) {
    for (const row of rows) {
      linesByEntity.set(row.legal_entity_id, row);
    }
  }

  for (const row of rows) {
    projected.push(row);

    const acquirerId = row.acquired_by_legal_entity_id;
    const moved = row.retainedAll - row.retainedInCompany;
    if (!acquirerId || moved <= MOVED_VALUE_EPSILON) {
      continue;
    }

    row.retainedAll = row.retainedInCompany;
    row.totalValue -= moved;
    // Whatever moved away is no longer this line's reason to read active; what
    // an earlier company's sale put here still is.
    row.holdsRetainedAssets = row.holdsTrackingAssets || row.carriesSwapValue;
    // What is left here is what the company itself paid out, so that is what
    // the return is now measured on.
    row.moic = statedMoic(row);

    const existing = mergeByCompany ? linesByEntity.get(acquirerId) : undefined;
    const line =
      existing ??
      deriveAcquirerRow(row, {
        id: acquirerId,
        name: row.acquirer.name ?? '',
        slug: row.acquirer.slug,
        image_url: row.acquirer.image_url,
      });

    line.retainedAll += moved;
    // Everything on an acquirer line tracks the acquirer, which is the company
    // this line is about.
    line.retainedInCompany += moved;
    line.totalValue += moved;
    line.holdsRetainedAssets = true;
    line.carriesSwapValue = true;
    line.moic = statedMoic(line);

    if (!existing) {
      // Straight after the company it came out of, so the two read together
      // whatever the surface is ordered by.
      projected.push(line);
      if (mergeByCompany) {
        linesByEntity.set(acquirerId, line);
      }
    }
  }

  return projected;
}

/** The chosen answer to "what does a line mean", applied to the rows. */
function applyPortfolioLens<Row extends LensRow>({
  lens,
  rows,
  mergeByCompany,
  deriveAcquirerRow,
}: {
  lens: PortfolioLens;
  rows: Row[];
  mergeByCompany: boolean;
  deriveAcquirerRow: (source: Row, acquirer: AcquirerRef) => Row;
}): Row[] {
  switch (lens) {
    case 'investment':
      return rows;
    case 'holdings':
      return withHoldingsLens({ rows, mergeByCompany, deriveAcquirerRow });
    default:
      return neverAsAny(lens);
  }
}

export { applyPortfolioLens, portfolioLensSchema, withHoldingsLens };
export type { AcquirerJoin, AcquirerRef, LensRow, PortfolioLens };
