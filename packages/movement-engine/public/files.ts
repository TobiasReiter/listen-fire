// Files: the document store a shell supplies, who owns a file ref, how a ref
// is redeemed into bytes, and what reading a file's text came to.

export * from '../services/translation_graph/engine/files/document_store';
export * from '../services/translation_graph/engine/files/file_outside_team';
export * from '../services/translation_graph/engine/files/file_owners';
export * from '../services/translation_graph/engine/files/redeem';
export * from '../services/translation_graph/engine/files/resources';
export type { FileTextResolution } from '../services/movement_engine/expression';
