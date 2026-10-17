import { z } from 'zod';

export const fieldConfigurationSchema = z.object({
  fieldId: z.number(),
  fieldName: z.string(),
  fieldType: z.string(),
  prompt: z.string(),
  overrideExisting: z.boolean().optional(),
});

export type AffinityFieldConfiguration = z.infer<typeof fieldConfigurationSchema>;
