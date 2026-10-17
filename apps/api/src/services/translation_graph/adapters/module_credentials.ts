// How the platform hands a built-in module its stored credential. Most
// modules declare exactly the payload the connect flow has always stored, and
// get it as is. An OAuth module declares the protocol's token fields
// (`access_token`, `refresh_token`, `expires_at`), which every host refreshes
// the same way; the platform's rows predate that and spell them its own way.
// The rows stay as they are (ciphertext and payload unchanged): a module's
// stored shape here translates between the two on read, write-back and
// refresh. The OAuth app a refresh uses is this deployment's, from the same
// environment the connect flow reads.

import type { CredentialFields } from 'module-kit';
import type { OAuth2ClientApp, SecretFields } from 'movement-engine/public/secrets';

/** A stored payload whose field names are not the module's declared ones. */
export interface StoredCredentialShape {
  /** The stored payload, as the module reads it. */
  toModule(stored: SecretFields): CredentialFields;
  /** Fields the module or a refresh changed, as the row spells them. */
  toStored(changed: CredentialFields): SecretFields;
}

/** Renames by a fixed table (stored name → module name); a field not named
 *  passes through under its own name. */
function renamed(table: Readonly<Record<string, string>>): StoredCredentialShape {
  const back = Object.fromEntries(Object.entries(table).map(([stored, module]) => [module, stored]));
  const rename = (fields: Readonly<Record<string, string>>, names: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(fields).map(([name, value]) => [names[name] ?? name, value]));
  return { toModule: (stored) => rename(stored, table), toStored: (changed) => rename(changed, back) };
}

const STORED_SHAPES: Readonly<Record<string, StoredCredentialShape>> = {
  '@lf/airtable': renamed({ accessToken: 'access_token', refreshToken: 'refresh_token', accessTokenExpiresAt: 'expires_at' }),
  '@lf/attio': renamed({ accessToken: 'access_token' }),
};

const IDENTITY: StoredCredentialShape = { toModule: (stored) => stored, toStored: (changed) => changed };

export function storedCredentialShape(moduleName: string): StoredCredentialShape {
  return STORED_SHAPES[moduleName] ?? IDENTITY;
}

const OAUTH_APP_ENV: Readonly<Record<string, { id: string; secret: string }>> = {
  '@lf/airtable': { id: 'AIRTABLE_CLIENT_ID', secret: 'AIRTABLE_CLIENT_SECRET' },
  '@lf/attio': { id: 'ATTIO_CLIENT_ID', secret: 'ATTIO_CLIENT_SECRET' },
};

/** This deployment's OAuth app at the module's provider, when it has one. */
export function platformOAuthApp(moduleName: string, env: Readonly<Record<string, string | undefined>> = process.env): OAuth2ClientApp | undefined {
  const names = OAUTH_APP_ENV[moduleName];
  const clientId = names !== undefined ? env[names.id] : undefined;
  const clientSecret = names !== undefined ? env[names.secret] : undefined;
  if (clientId === undefined || clientId === '' || clientSecret === undefined || clientSecret === '') return undefined;
  return { clientId, clientSecret };
}
