import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';
import fs from 'fs';
import path from 'path';
import { apiProxyRewrites } from './src/lib/api-proxy';

// The browser fetches the movement parser from public/ (src/lib/parser-provider.tsx).
// Copied here, where `next dev` and `next build` both pass, rather than by a
// webpack asset rule: the loader is CommonJS shared with the api, so it cannot
// name the file through `new URL(…, import.meta.url)`.
fs.copyFileSync(
  require.resolve('movement-lang/wasm/movement_parser.wasm'),
  path.join(__dirname, 'public', 'movement_parser.wasm'),
);

// The SERVER-side rewrite target, read at run time: one prebuilt image runs
// against any API. `NEXT_PUBLIC_API_URL` stays the escape hatch for a split
// deployment where the browser must call the API cross-origin directly.
const apiUrl = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Without this Next guesses the trace root from the nearest lockfiles and can
  // land ABOVE the repo, which moves `server.js` inside the standalone output.
  // Pin it to the workspace root so the image's CMD path is the same everywhere.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  experimental: {
    proxyTimeout: 300_000, // 5 minutes — agent mutations are long-running
  },
  typescript: {
    // Type-checking is handled by CI / local `tsc --noEmit`.
    // The tRPC types package references @prisma/client.$Enums which
    // requires `prisma generate` — unnecessary for the web app.
    ignoreBuildErrors: true,
  },
  transpilePackages: ['@listen-fire/shared', 'movement-lang', 'story-view'],
  webpack(config) {
    config.resolve.alias['#trpc'] = path.resolve(__dirname, 'node_modules/#trpc/types.ts');
    // The trpc types package's types.ts ends with `export { linkTrpcWsServer, trpcRouter }`
    // which are declare-only symbols. SWC strips the declarations but keeps the
    // export statement, causing "Export is not defined". Strip that line.
    config.module.rules.push({
      test: /trpc[\\/]types\.ts$/,
      loader: 'string-replace-loader',
      options: {
        search: /^export \{ linkTrpcWsServer, trpcRouter \};$/m.source,
        replace: '',
        flags: 'm',
      },
    });
    return config;
  },
  async redirects() {
    return [
      { source: '/ontology', destination: '/model', permanent: true },
      // The onboarding lobby is gone; the home page is the front door.
      { source: '/home', destination: '/dashboard', permanent: true },
      { source: '/inputs', destination: '/sources', permanent: true },
      { source: '/inputs/:id', destination: '/sources/:id', permanent: true },
      { source: '/outputs', destination: '/destinations', permanent: true },
      { source: '/outputs/:id', destination: '/destinations/:id', permanent: true },
      // `/plugins` now serves the movement-language plugin catalogue; the
      // legacy enrichment-plugin page stays reachable at `/enrichment`.
      // U2: substrate-named routes → user-vocabulary nav. The
      // underlying pages still exist (sources/destinations/integrations
      // are sub-sections of /connections; the deep pages stay live for
      // U5 to fold in). Only the list roots redirect.
      { source: '/triggers', destination: '/automations', permanent: true },
      { source: '/triggers/:id', destination: '/automations/:id', permanent: true },
      { source: '/sources', destination: '/connections#receivers', permanent: true },
      { source: '/destinations', destination: '/connections#destinations', permanent: true },
      { source: '/integrations', destination: '/connections#integrations', permanent: true },
    ];
  },
  async rewrites() {
    // The path list lives in src/lib/api-proxy.ts, shared with the middleware
    // that re-points these same paths at run time.
    return apiProxyRewrites(apiUrl);
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
});
