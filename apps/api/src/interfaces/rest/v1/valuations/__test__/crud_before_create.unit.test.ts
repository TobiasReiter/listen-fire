// The `beforeCreate` seam on buildCrudRouter: does a hook actually run on the
// create route, and do the columns it derives reach the insert?
//
// `mintUniqueSlug` has its own unit test (lib/valuations/__test__/slug.unit.test.ts),
// so this mocks the query builder and asserts only the router's own behaviour —
// that the hook is called with the parsed body, that what it returns is merged
// over that body, and that a caller-supplied value still wins.
//
// Mirrors the in-process express + node:http harness in commands.unit.test.ts
// (no supertest dependency in this repo).

import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';
import { z } from 'zod';

import type { AddressInfo } from 'node:net';


const enterTransaction = jest.fn();
const insertedValues = jest.fn();

jest.mock('../../../../../services/context', () => ({
  currentContext: () => ({ enterTransaction: () => enterTransaction() }),
}));

jest.mock('../shared', () => {
  const actual = jest.requireActual('../shared');
  return {
    ...actual,
    teamId: () => 'team-1',
    valuationsQb: () => ({
      insertInto: () => ({
        values: (v: Record<string, unknown>) => {
          insertedValues(v);
          return {
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => ({ id: 'row-1', ...v }),
            }),
          };
        },
      }),
    }),
  };
});

import { buildCrudRouter } from '../crud';

let server: Server;
let baseUrl: string;
const beforeCreate = jest.fn();

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(
    '/things',
    buildCrudRouter({
      table: 'legal_entity',
      defaultSort: 'created_at',
      listSchema: z.object({}),
      createSchema: z.object({ name: z.string().min(1), slug: z.string().optional() }),
      beforeCreate: (values, qb) => beforeCreate(values, qb),
    }) as Router,
  );
  server = createServer(app);
  server.listen(0, () => {
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  enterTransaction.mockResolvedValue(undefined);
});

async function create(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/things`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('buildCrudRouter beforeCreate', () => {
  it('merges the columns the hook derives into the insert', async () => {
    beforeCreate.mockResolvedValue({ slug: 'acme' });

    const res = await create({ name: 'Acme' });

    expect(res.status).toBe(201);
    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme', slug: 'acme', team_id: 'team-1' }),
    );
  });

  it('gives the hook the parsed body including the team id', async () => {
    beforeCreate.mockResolvedValue({});

    await create({ name: 'Acme' });

    expect(beforeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme', team_id: 'team-1' }),
      expect.anything(),
    );
  });

  // The hook derives what the caller DIDN'T supply. A hook that returns {}
  // must leave an explicit value alone — this is what stops a minted slug
  // trampling one somebody chose.
  it('leaves a caller-supplied value alone when the hook declines', async () => {
    beforeCreate.mockResolvedValue({});

    await create({ name: 'Acme', slug: 'acme-chosen-by-hand' });

    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'acme-chosen-by-hand' }),
    );
  });

  it('runs the hook inside the create transaction', async () => {
    const order: string[] = [];
    enterTransaction.mockImplementation(() => {
      order.push('transaction');
      return Promise.resolve(undefined);
    });
    beforeCreate.mockImplementation(() => {
      order.push('hook');
      return Promise.resolve({});
    });

    await create({ name: 'Acme' });

    expect(order).toEqual(['transaction', 'hook']);
  });

  it('never reaches the hook when the body fails validation', async () => {
    const res = await create({ name: '' });

    expect(res.status).toBe(400);
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(insertedValues).not.toHaveBeenCalled();
  });
});
