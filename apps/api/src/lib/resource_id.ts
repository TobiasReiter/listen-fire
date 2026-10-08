// A resource id arriving as plain text (a run's `Resource`, whose contract
// carries no database brand) — the boundary check that names it as one.

import { z } from 'zod';
import type { ResourceId } from '../generated/kysely/knowledge/Resource';

export const resourceIdSchema = z.custom<ResourceId>((value) => z.uuid().safeParse(value).success);
