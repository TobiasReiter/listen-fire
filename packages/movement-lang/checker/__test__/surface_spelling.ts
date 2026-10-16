// A suite that runs one program under every language version writes it once,
// in the spelling versions 1–4 read, and checks the version-5 run against the
// program the upgrade tool rewrites it to (the same loop `lf upgrade` runs) —
// so a version-5 check always reads the version-5 surface, and the two
// spellings must answer the same. Only the respellings are applied (the
// `MOV_V5_*` fixes): a fix for the error a test is about never is.

import { parseProgram, MovementParseError } from '../../parser/parse';
import { checkProgram, type CheckOptions, type Diagnostic } from '../check';
import type { Catalog } from '../catalog';
import { spellingCheck, upgradeSource } from '../upgrade';
import type { LanguageVersion } from '../../language_version';

const isRespelling = (d: Diagnostic): boolean => d.code.startsWith('MOV_V5_');

/** `source` as `version` spells it. With a catalog, the respellings only a
 *  check can decide (a built-in read by its argument's type, a call's named
 *  arguments put in order) are applied too. */
export function spelledFor(
  version: LanguageVersion,
  source: string,
  catalog?: Catalog,
  options: Omit<CheckOptions, 'languageVersion'> = {},
): string {
  if (version < 5) return source;
  const check =
    catalog === undefined
      ? spellingCheck(version)
      : (text: string): Diagnostic[] => {
          try {
            return checkProgram(parseProgram(text, { languageVersion: version }), catalog, { ...options, languageVersion: version });
          } catch (error) {
            if (error instanceof MovementParseError) return [];
            throw error;
          }
        };
  return upgradeSource(source, (text) => check(text).filter(isRespelling), { all: true }).source;
}
