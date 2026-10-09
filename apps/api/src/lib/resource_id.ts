// A resource id arriving as plain text (a run's `Resource`, whose contract
// carries no database brand) — the boundary check that names it as one. Any
// GUID-shaped id: Postgres' `uuid` takes one whatever its version bits.

import { z } from 'zod';

import type { ResourceId } from '../generated/kysely/knowledge/Resource';

export const resourceIdSchema = z.custom<ResourceId>((value) => z.guid().safeParse(value).success);
