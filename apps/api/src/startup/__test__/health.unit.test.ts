// The invariant the workers surface exists to keep: an UNMOUNTED product
// contributes no rows, so its absence can never be read as a wedged worker.
// The registries are stubbed — what is under test is the composition rule and
// the row shape, not any product's queries.

jest.mock('movement-engine/services/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));

const mockRegistry = (unit: string, ids: string[]) => ({
  unit,
  workers: ids.map((id) => ({ id, start: () => {} })),
});

jest.mock('../core', () => ({ coreStartup: mockRegistry('core', []) }));
jest.mock('../valuations', () => ({
  valuationsWorkers: mockRegistry('valuations', ['valuations.change_outbox']),
}));
jest.mock('../automations', () => ({
  automationsWorkers: mockRegistry('automations', ['automations.cron_scheduler']),
}));
jest.mock('../knowledge', () => ({
  knowledgeWorkers: mockRegistry('knowledge', ['knowledge.mutation_outbox']),
}));
jest.mock('../asks', () => ({ asksWorkers: mockRegistry('asks', ['asks.ask_webhook_delivery']) }));
// The real residual registers no loops today; the stub gives it one so the
// composition rule ("rides with the composed deployment only") is testable
// independently of what happens to live there.
jest.mock('../residual', () => ({
  residualWorkers: mockRegistry('residual', ['residual.stub']),
}));

function loadHealth(products: string, principal: string) {
  process.env.LISTEN_FIRE_PRODUCTS = products;
  process.env.LISTEN_FIRE_PRINCIPAL = principal;
  jest.resetModules();
  return require('../health') as typeof import('../health');
}

describe('the workers surface reports only what this process mounts', () => {
  const saved = {
    products: process.env.LISTEN_FIRE_PRODUCTS,
    principal: process.env.LISTEN_FIRE_PRINCIPAL,
    version: process.env.LISTEN_FIRE_VERSION,
  };
  afterEach(() => {
    process.env.LISTEN_FIRE_PRODUCTS = saved.products;
    process.env.LISTEN_FIRE_PRINCIPAL = saved.principal;
    process.env.LISTEN_FIRE_VERSION = saved.version;
  });

  it('lists a standalone product\'s workers and nobody else\'s', async () => {
    const { readWorkersHealth, mountedWorkerIds } = loadHealth('valuations', 'static');

    expect(mountedWorkerIds()).toEqual(['valuations.change_outbox']);

    const { products, workers } = await readWorkersHealth();
    expect(products).toEqual(['valuations']);
    expect(workers.map((w) => w.worker)).toEqual(['valuations.change_outbox']);
  });

  it('rides the residual with the composed deployment only', () => {
    expect(loadHealth('all', 'core').mountedWorkerIds()).toContain('residual.stub');
    // core is mounted here and contributes nothing: it registers no loops.
    expect(loadHealth('core,knowledge', 'core').mountedWorkerIds()).toEqual([
      'knowledge.mutation_outbox',
    ]);
  });

  it('reports the release it is running, and says `dev` when nothing baked one in', async () => {
    process.env.LISTEN_FIRE_VERSION = 'v1.2.3';
    expect((await loadHealth('asks', 'static').readWorkersHealth()).version).toBe('v1.2.3');

    delete process.env.LISTEN_FIRE_VERSION;
    expect((await loadHealth('asks', 'static').readWorkersHealth()).version).toBe('dev');
  });

  it('reports a worker this process never started as not-started, not as failing', async () => {
    const { readWorkersHealth } = loadHealth('asks', 'static');

    const [row] = (await readWorkersHealth()).workers;
    expect(row).toMatchObject({
      unit: 'asks',
      worker: 'asks.ask_webhook_delivery',
      startedHere: false,
      lastTickAt: null,
      failing: false,
      queue: null,
      idleReason: null,
    });
  });
});
