# The language service

`lf lsp` is a language server over stdio (LSP 3.17, UTF-16 positions). Its answers come from the crate `listen-fire-language` (crates/movement-language), written for language version 5. The Rust parser and checker are its reference. It is not a port of the TypeScript service.

Not a versioned contract: an editor speaks LSP, and LSP is the contract. This page says what the service answers, and from where.

## One analysis, many questions

- **The check is the analysis.** Each question is answered from one run of the Rust checker over the file and the project's catalog. The checker keeps what its walk settled (`movement_checker::query::analyze`):
  - every scope a body opens (a function, a closure, an `if` arm, a traversal block), with the text it covers;
  - every symbol ever bound in each scope, with its span and the type the check gave it;
  - each imported name, with the library declaration it resolved to.
- **No second type checker.** The service never re-derives a type. Where it needs one the check did not keep, it calls the checker's own type functions: a field read off a record, or where an edge lands.
- **Half-typed code still answers.** When the file does not parse, the service blanks the line the cursor is on and parses again. If that still fails, it keeps the text above the cursor and closes the open braces. The parse error is still reported, as `MOV_PARSE`, on the original text.

## What a position answers

| question | answer | source |
|---|---|---|
| what is in scope | each binding, parameter, function, node, type, import and host unit (`cron`, `manual`) visible here, innermost first, with its type | the check's scopes, cut off at the cursor (a hoisted declaration is seen from anywhere in its list) |
| what follows `x.` or `` x.` `` | the record's fields with their types | the symbol's record type, through the catalog schema |
| what follows `-[`, `-[a:` | the edges the walk can take next, and where each lands | the record's (or instance's) edges in the catalog |
| what follows `a.` for a hop alias `a` | the fields where that hop lands | the walk's root type, stepped edge by edge with the checker's `edge_landing` |
| what follows `<x-[:` in a type | the record types of instance `x` | the instance's schema |
| a built-in | its v5 spelling and signature | the spelling table (crates/movement-parser/src/surface/table.rs) and the standard library's signatures |
| inside `import { … } from adapters` / `plugins` | module tags (`` `@lf/<name>` ``) and plugin names | the catalog's adapters (host units left out), plugin packages and plugins |
| inside `listen to x { … }` | the listen's settings keys | the source's `triggerConfig` (`every` replaces `pollIntervalSeconds`), and `suppress_self` |
| after `connect x using` | credential names serving that module | the catalog's credentials, built from lf's secrets bindings (names only, never values) |

## The LSP methods

- **Diagnostics** (`textDocument/publishDiagnostics`): the checker's diagnostics for each open file, against the project's catalog. They are recomputed 200 ms after the last edit. Open buffers stand in for their files when another file imports them.
- **Hover:** the type, a one-line doc, and a link to the versioned docs page: `https://listen-fire.github.io/docs/v5/<page>#<anchor>`.
- **Completion:** the table above, picked by what the text just before the cursor is.
- **Go to definition:** a binding, parameter, function or node goes to where it is declared. An imported name goes to its declaration in the library file.
- **Code actions:** each diagnostic's own fix (`MOV_V5_SPELLING` and every other fix the checker offers) as a quick fix. A "did you mean 'x'" in a message becomes a quick fix that replaces the misspelled name.

## The project

- `lf lsp` reads the project the way `lf check` does: lf.yaml, the movement files, and the externals' described schemas.
- If the externals cannot start (a missing credential, a module that fails), the service falls back to a catalog of the host units, the credentials and the files alone, and says so in a log message.
