// The judge's prompts live as files beside this module so a prompt edit is a
// prompt diff, not a code diff. They are read once, at first use.

import fs from 'node:fs';
import path from 'node:path';

const PROMPT_NAMES = ['entity_match.system', 'entity_match.user', 'jev_same', 'jev_evidence'] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

const cache = new Map<PromptName, string>();

export function promptText(name: PromptName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  // The editor's final newline is not part of the prompt.
  const text = fs.readFileSync(path.join(__dirname, 'prompts', `${name}.md`), 'utf8').replace(/\n$/, '');
  cache.set(name, text);
  return text;
}

/** Fill `{{{key}}}` slots in one pass, so a filled-in value that itself looks
 *  like a slot is never filled again. An unknown key fills as nothing. */
export function fillSlots(template: string, values: Record<string, string>): string {
  return template.replace(/{{{([^}]+)}}}/g, (_, key: string) => (key in values ? values[key] : ''));
}
