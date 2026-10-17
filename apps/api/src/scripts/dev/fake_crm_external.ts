// The fake CRM (`fake_crm_adapter.ts`) as an lf external: a plain process
// that serves it behind the wire protocol on PORT (0: any free port) and
// prints `listening <port>`, the way lf starts an external it is handed in an
// `lf-external.yaml`. It lets `lf` run movements against the reference
// protocol-v2 adapter. Its ledger is in memory:
// it lives as long as the lf process that started it.

import { FAKE_CRM_SECRET, startFakeCrmServer } from './fake_crm_adapter';

async function main(): Promise<void> {
  const server = await startFakeCrmServer({ secret: process.env.FAKE_CRM_SECRET ?? FAKE_CRM_SECRET, port: Number(process.env.PORT ?? 0) });
  process.stdout.write(`listening ${new URL(server.baseUrl).port}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`fake CRM: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
