import { Router, type RequestHandler } from 'express';
import { z, type ZodType } from 'zod';

import type { Kysely } from 'kysely';

import { currentContext } from '../../../../services/context';
import { valuationsQb, teamId, internalError, fkConflictError, paginationQuery, uuidParam } from './shared';

interface CrudConfig {
  table: string;
  teamIdColumn?: string | null; // column name; pass null to disable team scoping (e.g. exchange_rate)
  defaultSort: string;
  listSchema: ZodType;
  createSchema?: ZodType;
  updateSchema?: ZodType;
  // Map from external field names to allowed sort columns
  sortableColumns?: string[];
  // Additional filters applied to list query
  listFilters?: (query: any, params: Record<string, unknown>) => any;
  // Transform row for response (camelCase → snake_case, field subsetting, etc.)
  transformRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  // Derive columns the caller did not supply, on the way in. Runs inside the
  // create transaction with the same query builder, so a hook may read the
  // table it is about to write (minting a unique slug, say). Whatever it
  // returns is merged over the parsed body.
  beforeCreate?: (
    values: Record<string, unknown>,
    qb: Kysely<any>,
  ) => Promise<Record<string, unknown>>;
}

function buildCrudRouter(config: CrudConfig): ReturnType<typeof Router> {
  const router = Router();
  const {
    table,
    defaultSort,
    listSchema,
    createSchema,
    updateSchema,
    sortableColumns,
    listFilters,
    transformRow = (r) => r,
    beforeCreate,
  } = config;
  const teamIdColumn = config.teamIdColumn === undefined ? 'team_id' : config.teamIdColumn;

  function teamFilter(query: any) {
    if (teamIdColumn) {
      return query.where(`${table}.${teamIdColumn}`, '=', teamId());
    }
    return query;
  }

  // LIST
  const listHandler: RequestHandler = async (req, res) => {
    const parseResult = listSchema.safeParse(req.query);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: parseResult.error.flatten() });
    }

    const params = parseResult.data as Record<string, unknown> & {
      limit: number;
      offset: number;
      sort?: string;
      order: 'asc' | 'desc';
    };

    try {
      const qb = valuationsQb();
      let query = qb.selectFrom(table);
      query = teamFilter(query);

      if (listFilters) {
        query = listFilters(query, params);
      }

      const sortCol = params.sort && sortableColumns?.includes(params.sort) ? params.sort : defaultSort;
      const rows = await query
        .selectAll()
        .orderBy(sortCol, params.order)
        .limit(params.limit)
        .offset(params.offset)
        .execute();

      return res.status(200).json({
        data: rows.map(transformRow),
        meta: { count: rows.length, offset: params.offset, limit: params.limit },
      });
    } catch (err) {
      return internalError(res, err);
    }
  };

  // GET
  const getHandler: RequestHandler = async (req, res) => {
    const paramResult = uuidParam.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: 'Invalid id parameter' });
    }

    try {
      const qb = valuationsQb();
      let query = qb.selectFrom(table).where(`${table}.id`, '=', paramResult.data.id);
      query = teamFilter(query);

      const row = await query.selectAll().executeTakeFirst();
      if (!row) {
        return res.status(404).json({ error: 'Not found' });
      }

      return res.status(200).json({ data: transformRow(row as Record<string, unknown>) });
    } catch (err) {
      return internalError(res, err);
    }
  };

  router.get('/', listHandler);
  router.get('/:id', getHandler);

  // CREATE
  if (createSchema) {
    const createHandler: RequestHandler = async (req, res) => {
      const parseResult = createSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.flatten() });
      }

      try {
        await currentContext().enterTransaction();
        const qb = valuationsQb();
        let values = { ...(parseResult.data as Record<string, unknown>) };
        if (teamIdColumn) {
          values[teamIdColumn] = teamId();
        }
        if (beforeCreate) {
          values = { ...values, ...(await beforeCreate(values, qb)) };
        }

        const row = await qb
          .insertInto(table)
          .values(values)
          .returningAll()
          .executeTakeFirstOrThrow();

        return res.status(201).json({ data: transformRow(row as Record<string, unknown>) });
      } catch (err) {
        return internalError(res, err);
      }
    };
    router.post('/', createHandler);
  }

  // UPDATE (PATCH)
  if (updateSchema) {
    const updateHandler: RequestHandler = async (req, res) => {
      const paramResult = uuidParam.safeParse(req.params);
      if (!paramResult.success) {
        return res.status(400).json({ error: 'Invalid id parameter' });
      }

      const parseResult = updateSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.flatten() });
      }

      const updates = parseResult.data as Record<string, unknown>;
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      try {
        await currentContext().enterTransaction();
        const qb = valuationsQb();
        let query = qb
          .updateTable(table)
          .set({ ...updates, updated_at: new Date() })
          .where(`${table}.id`, '=', paramResult.data.id);

        if (teamIdColumn) {
          query = query.where(`${table}.${teamIdColumn}`, '=', teamId());
        }

        const row = await query.returningAll().executeTakeFirst();
        if (!row) {
          return res.status(404).json({ error: 'Not found' });
        }

        return res.status(200).json({ data: transformRow(row as Record<string, unknown>) });
      } catch (err) {
        return internalError(res, err);
      }
    };
    router.patch('/:id', updateHandler);
  }

  // DELETE
  if (createSchema) {
    // If we can create, we can delete (except exchange_rate which has no createSchema)
    const deleteHandler: RequestHandler = async (req, res) => {
      const paramResult = uuidParam.safeParse(req.params);
      if (!paramResult.success) {
        return res.status(400).json({ error: 'Invalid id parameter' });
      }

      try {
        await currentContext().enterTransaction();
        const qb = valuationsQb();
        let query = qb.deleteFrom(table).where(`${table}.id`, '=', paramResult.data.id);
        if (teamIdColumn) {
          query = query.where(`${table}.${teamIdColumn}`, '=', teamId());
        }

        const result = await query.executeTakeFirst();
        if (result.numDeletedRows === 0n) {
          return res.status(404).json({ error: 'Not found' });
        }

        return res.status(204).send();
      } catch (err) {
        const conflict = fkConflictError(res, err);
        if (conflict) return conflict;
        return internalError(res, err);
      }
    };
    router.delete('/:id', deleteHandler);
  }

  return router;
}

export { buildCrudRouter, type CrudConfig };
