// Secrets and credentials: the secrets host family (resolve a credential,
// write it back at a version, refresh it once at a time), the host's generic
// OAuth 2 refresh from a module's manifest, connecting an OAuth 2 credential
// from the same declaration, and the in-memory vault an embedder starts from.
// Each store (a file, the environment, an encrypted table, a vault)
// implements `SecretsBackend`.

export * from '../services/secrets/family';
export * from '../services/secrets/oauth2';
export * from '../services/secrets/connect';
export * from '../services/secrets/memory';
