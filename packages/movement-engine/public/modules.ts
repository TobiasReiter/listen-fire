// Modules served as processes, from the host's side: the remote adapter that
// calls one over adapter protocol 2 (every call validated against the
// protocol, its credential sent, refreshed and written back), and the
// manifest fetch an install reads it with; and the rewrite that names the
// files a module reads out as its install's, for a module loaded in process
// too. The serving side is module-kit.

export * from '../services/translation_graph/adapters/remote';
export * from '../services/translation_graph/adapters/owned_files';
