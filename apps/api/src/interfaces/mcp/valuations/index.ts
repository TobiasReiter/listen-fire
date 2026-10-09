// The flat tool surface for the valuations connector. Reads are read-only (no
// access prompt); writes call the funding-tab mutations. The generic
// call_api/describe_api shim is kept alongside these for back-compat.

import type { TopLevelTool } from '../server';

import { getCompanyFunding, findCompanies } from './reads';
import { valuationsHelperReadTools } from './helper_reads';
import { valuationsWriteTools } from './writes';
import { portfolioTools } from './portfolio';
import { valuationsQueryTools } from './query';

const valuationsTools: Record<string, TopLevelTool> = {
  getCompanyFunding,
  findCompanies,
  ...portfolioTools,
  ...valuationsQueryTools,
  ...valuationsHelperReadTools,
  ...valuationsWriteTools,
};

const valuationsInstructions =
  'Read and edit the valuations / funding picture for your portfolio and companies. For a ' +
  'portfolio-wide view (every company with its MOIC and first-investment date), use ' +
  'listPortfolioCompanies. For one company, findCompanies to resolve a name then ' +
  'getCompanyFunding for its metrics, rounds, history, and first-investment MOIC. For the raw ' +
  'atoms behind either — any filter, any grouping, no fixed columns — use queryValuations. ' +
  'Reads are read-only.';

export { valuationsTools, valuationsInstructions };
