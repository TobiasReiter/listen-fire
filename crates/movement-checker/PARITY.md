# Checker parity: Rust against TypeScript

Written by `crates/movement-checker/parity/run.sh`. Do not edit by hand.

- Codes at parity: **31 of 220** codes the TypeScript checker reports on this corpus.
- Diagnostics matched: 11184 of 15246; 0 extra in Rust.
- Records with exactly the TypeScript's diagnostics, in its order: 7741 of 11435.
- Rust side: 8.0s; 0 records the Rust parser or catalog refused; 0 panics.

A code is at parity when every diagnostic of it on the corpus is matched exactly and Rust reports none extra.

| corpus | records | exact | same diagnostics, any order |
|---|---|---|---|
| checks under v5 | 2360 | 1227 | 1227 |
| checks v1 | 1535 | 889 | 889 |
| checks v2 | 1956 | 1103 | 1103 |
| checks v3 | 2403 | 1341 | 1341 |
| checks v99 | 5 | 5 | 5 |
| oracle handles | 981 | 981 | 981 |
| oracle parallel | 398 | 398 | 398 |
| oracle records | 1797 | 1797 | 1797 |

## By family

| family | codes seen | at parity | TS diagnostics | matched | missing | extra | message differs |
|---|---|---|---|---|---|---|---|
| calls | 26 | 0 | 476 | 4 | 472 | 0 | 0 |
| closures | 14 | 0 | 305 | 0 | 305 | 0 | 0 |
| extraction | 20 | 0 | 207 | 0 | 207 | 0 | 0 |
| flow | 10 | 0 | 78 | 0 | 78 | 0 | 0 |
| imports | 5 | 5 | 44 | 44 | 0 | 0 | 0 |
| listens | 12 | 11 | 10671 | 10667 | 4 | 0 | 0 |
| names | 9 | 8 | 371 | 367 | 4 | 0 | 0 |
| nodes | 25 | 0 | 314 | 0 | 314 | 0 | 0 |
| records | 3 | 0 | 59 | 0 | 59 | 0 | 0 |
| systems | 8 | 6 | 100 | 85 | 15 | 0 | 0 |
| values | 22 | 0 | 1156 | 12 | 1144 | 0 | 0 |
| versions | 2 | 1 | 7 | 5 | 2 | 0 | 0 |
| walks | 19 | 0 | 745 | 0 | 745 | 0 | 0 |
| writes | 45 | 0 | 713 | 0 | 713 | 0 | 0 |

## By code

| code | family | TS | matched | missing in Rust | extra in Rust | message differs | parity |
|---|---|---|---|---|---|---|---|
| MOV_ABSENT_REQUIRED | values | 514 | 0 | 514 | 0 | 0 |  |
| MOV_ADAPTER_NOT_CONSTRUCTED | systems | 28 | 28 | 0 | 0 | 0 | yes |
| MOV_AI_TIER_LEGACY | systems | 8 | 4 | 4 | 0 | 0 |  |
| MOV_AMBIGUOUS_PROPERTY | walks | 4 | 0 | 4 | 0 | 0 |  |
| MOV_ARITH_NON_NUMERIC | values | 79 | 0 | 79 | 0 | 0 |  |
| MOV_AWAIT_BAD_DURATION | flow | 4 | 0 | 4 | 0 | 0 |  |
| MOV_AWAIT_BARE_WALK | flow | 12 | 0 | 12 | 0 | 0 |  |
| MOV_AWAIT_IMPURE_CONDITION | flow | 12 | 0 | 12 | 0 | 0 |  |
| MOV_AWAIT_NEEDS_CADENCE | flow | 8 | 0 | 8 | 0 | 0 |  |
| MOV_AWAIT_NOT_AWAITABLE | flow | 12 | 0 | 12 | 0 | 0 |  |
| MOV_BLOCK_READ_BACK_RETIRED | closures | 12 | 0 | 12 | 0 | 0 |  |
| MOV_BLOCK_RETURNS_NOTHING | closures | 152 | 0 | 152 | 0 | 0 |  |
| MOV_BORROW_UNKNOWN_FIELD | nodes | 12 | 0 | 12 | 0 | 0 |  |
| MOV_BORROW_UNKNOWN_GRAPH | nodes | 12 | 0 | 12 | 0 | 0 |  |
| MOV_BORROW_UNKNOWN_ROOT | nodes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_BUILTIN_ARGS | calls | 22 | 0 | 22 | 0 | 0 |  |
| MOV_BUILTIN_ARG_TYPE | calls | 20 | 0 | 20 | 0 | 0 |  |
| MOV_BUILTIN_NOT_RUN | calls | 6 | 0 | 6 | 0 | 0 |  |
| MOV_BUILTIN_UNUSED | calls | 2 | 0 | 2 | 0 | 0 |  |
| MOV_CALLBACK_BAD_CONFIG | listens | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_CALLBACK_NOT_MOVEMENT | listens | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_CALLBACK_PARAM_NOT_VALUE | listens | 14 | 14 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_DUPLICATE | calls | 8 | 0 | 8 | 0 | 0 |  |
| MOV_CALL_ARG_MISSING | calls | 24 | 0 | 24 | 0 | 0 |  |
| MOV_CALL_ARG_TYPE | calls | 55 | 0 | 55 | 0 | 0 |  |
| MOV_CALL_ARG_UNKNOWN | calls | 18 | 0 | 18 | 0 | 0 |  |
| MOV_CALL_ARITY | calls | 18 | 0 | 18 | 0 | 0 |  |
| MOV_CALL_NESTED | calls | 12 | 0 | 12 | 0 | 0 |  |
| MOV_CALL_NOT_MOVEMENT | calls | 13 | 4 | 9 | 0 | 0 |  |
| MOV_CALL_RETURNS_NOTHING | calls | 22 | 0 | 22 | 0 | 0 |  |
| MOV_CHUNKS_NOT_TEXT | extraction | 4 | 0 | 4 | 0 | 0 |  |
| MOV_COLLECTION_OP_ARITY | closures | 8 | 0 | 8 | 0 | 0 |  |
| MOV_COLLECTION_OP_CONFIG | closures | 14 | 0 | 14 | 0 | 0 |  |
| MOV_COLLECTION_OP_NOT_A_COLLECTION | closures | 10 | 0 | 10 | 0 | 0 |  |
| MOV_COLLECTION_OP_RETURNS_NOTHING | closures | 12 | 0 | 12 | 0 | 0 |  |
| MOV_COLLECTION_OP_SUSPENDS | closures | 2 | 0 | 2 | 0 | 0 |  |
| MOV_COMBINATOR_ARMS_ARE_ARGUMENTS | closures | 30 | 0 | 30 | 0 | 0 |  |
| MOV_COMBINATOR_ARM_NOT_FUNCTION | closures | 5 | 0 | 5 | 0 | 0 |  |
| MOV_COMBINATOR_ARM_TAKES_NOTHING | closures | 4 | 0 | 4 | 0 | 0 |  |
| MOV_COMBINATOR_NEEDS_AWAIT | closures | 6 | 0 | 6 | 0 | 0 |  |
| MOV_COMBINATOR_NO_AWAIT | closures | 28 | 0 | 28 | 0 | 0 |  |
| MOV_COMPARE_TYPE_MISMATCH | values | 60 | 0 | 60 | 0 | 0 |  |
| MOV_CONSTRUCT_BAD_ARG | systems | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_MISSING_CRED | systems | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_NOT_ADAPTER | systems | 13 | 13 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_UNKNOWN_OPTION | systems | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_CRED_WRONG_ADAPTER | systems | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_DELETE_NOT_DECLARED | writes | 1 | 0 | 1 | 0 | 0 |  |
| MOV_DICT_KEY_NOT_TEXT | values | 12 | 0 | 12 | 0 | 0 |  |
| MOV_DICT_UNKNOWN_KEY | values | 25 | 0 | 25 | 0 | 0 |  |
| MOV_DUPLICATE_DECL | names | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_ENUM_EMPTY_DOMAIN | values | 12 | 0 | 12 | 0 | 0 |  |
| MOV_ENUM_UNKNOWN_VALUE | values | 118 | 12 | 106 | 0 | 0 |  |
| MOV_EXPR_PARSE | calls | 141 | 0 | 141 | 0 | 0 |  |
| MOV_EXTENDS_CYCLE | nodes | 9 | 0 | 9 | 0 | 0 |  |
| MOV_EXTENDS_NOT_A_NODE | nodes | 3 | 0 | 3 | 0 | 0 |  |
| MOV_EXTENDS_REDEFINES | nodes | 6 | 0 | 6 | 0 | 0 |  |
| MOV_EXTRACT_ANNOTATE | extraction | 12 | 0 | 12 | 0 | 0 |  |
| MOV_EXTRACT_CALL_NESTED | extraction | 4 | 0 | 4 | 0 | 0 |  |
| MOV_EXTRACT_CONFIG | extraction | 14 | 0 | 14 | 0 | 0 |  |
| MOV_EXTRACT_CONTENT | extraction | 18 | 0 | 18 | 0 | 0 |  |
| MOV_EXTRACT_FIELD_DUPLICATE | extraction | 10 | 0 | 10 | 0 | 0 |  |
| MOV_EXTRACT_NEEDS_ANNOTATION | extraction | 7 | 0 | 7 | 0 | 0 |  |
| MOV_EXTRACT_SHAPE_COMPUTED | extraction | 6 | 0 | 6 | 0 | 0 |  |
| MOV_EXTRACT_SHAPE_NOT_DECLARED | extraction | 3 | 0 | 3 | 0 | 0 |  |
| MOV_EXTRACT_TYPE_CONFLICT | extraction | 12 | 0 | 12 | 0 | 0 |  |
| MOV_EXTRACT_UNKNOWN_FIELD | extraction | 22 | 0 | 22 | 0 | 0 |  |
| MOV_FOLD_NEEDS_ORDER | values | 109 | 0 | 109 | 0 | 0 |  |
| MOV_FUNCTION_NAME_COLLISION | names | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_FUNCTION_UNKNOWN | calls | 14 | 0 | 14 | 0 | 0 |  |
| MOV_GRAPH_ENTRY_KIND | nodes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_GRAPH_FIELD_MISSING | nodes | 18 | 0 | 18 | 0 | 0 |  |
| MOV_GRAPH_FIELD_TYPE | nodes | 12 | 0 | 12 | 0 | 0 |  |
| MOV_GRAPH_FIELD_UNKNOWN | nodes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_GRAPH_REFERENCE_SHAPE | nodes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_GRAPH_SHAPE | nodes | 2 | 0 | 2 | 0 | 0 |  |
| MOV_GRAPH_SPREAD_NOT_MAP | nodes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_GRAPH_SPREAD_UNTYPED | nodes | 2 | 0 | 2 | 0 | 0 |  |
| MOV_HEAD_NEEDS_A_NAME | flow | 4 | 0 | 4 | 0 | 0 |  |
| MOV_HEAD_NOT_A_POSITION | walks | 24 | 0 | 24 | 0 | 0 |  |
| MOV_HOP_CONFIG_UNREAD | walks | 6 | 0 | 6 | 0 | 0 |  |
| MOV_HOP_FILTER_ENGINE | walks | 8 | 0 | 8 | 0 | 0 |  |
| MOV_HOP_FILTER_RESIDUAL | walks | 12 | 0 | 12 | 0 | 0 |  |
| MOV_HOP_FILTER_UNSUPPORTED | walks | 16 | 0 | 16 | 0 | 0 |  |
| MOV_HOP_ORDER_ENGINE | walks | 38 | 0 | 38 | 0 | 0 |  |
| MOV_HOP_ORDER_UNSUPPORTED | walks | 16 | 0 | 16 | 0 | 0 |  |
| MOV_IF_WITHOUT_ELSE | flow | 6 | 0 | 6 | 0 | 0 |  |
| MOV_IMPORT_CYCLE | imports | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_IMPORT_DUPLICATE | names | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_INVALID | imports | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_UNRESOLVED | imports | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_UNSUPPORTED | imports | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_IMPORT_NOT_EXPORTED | imports | 20 | 20 | 0 | 0 | 0 | yes |
| MOV_IMPORT_UNKNOWN | names | 20 | 20 | 0 | 0 | 0 | yes |
| MOV_INLINE_BLOCK_RETIRED | closures | 8 | 0 | 8 | 0 | 0 |  |
| MOV_JSON_OPAQUE | values | 56 | 0 | 56 | 0 | 0 |  |
| MOV_LANGUAGE_VERSION_UNSUPPORTED | versions | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_LIMIT_NEEDS_ORDER | walks | 8 | 0 | 8 | 0 | 0 |  |
| MOV_LINKED_HOP_RETIRED | writes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_LINKED_NEEDS_TYPE | writes | 15 | 0 | 15 | 0 | 0 |  |
| MOV_LINKED_TYPE_MISMATCH | writes | 12 | 0 | 12 | 0 | 0 |  |
| MOV_LINKED_UNKNOWN_EDGE | writes | 39 | 0 | 39 | 0 | 0 |  |
| MOV_LINK_MATCH_BODY_RETIRED | writes | 15 | 0 | 15 | 0 | 0 |  |
| MOV_LINK_UNSUPPORTED_EDGE | writes | 12 | 0 | 12 | 0 | 0 |  |
| MOV_LISTEN_ALIAS_DUPLICATE | listens | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_LISTEN_BAD_CONFIG | listens | 138 | 134 | 4 | 0 | 0 |  |
| MOV_LISTEN_CANNOT_FIRE | listens | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_LISTEN_DUPLICATE | listens | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_LISTEN_FILE_LEVEL | listens | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_LISTEN_MISSING | listens | 10299 | 10299 | 0 | 0 | 0 | yes |
| MOV_LISTEN_NOT_INSTANCE | listens | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_LISTEN_PARAM_MISMATCH | listens | 142 | 142 | 0 | 0 | 0 | yes |
| MOV_LISTEN_SHAPE_MISMATCH | listens | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_LIST_MIXED | values | 21 | 0 | 21 | 0 | 0 |  |
| MOV_LIST_SPREAD_NOT_A_LIST | values | 8 | 0 | 8 | 0 | 0 |  |
| MOV_MAP_KEY_OVERWRITTEN | values | 13 | 0 | 13 | 0 | 0 |  |
| MOV_MAP_SPREAD_NOT_KEYED | values | 6 | 0 | 6 | 0 | 0 |  |
| MOV_MATCH_NO_IDENTITY | writes | 9 | 0 | 9 | 0 | 0 |  |
| MOV_MATCH_UNNAMED | writes | 29 | 0 | 29 | 0 | 0 |  |
| MOV_MEMBERS_NOT_CLOSED | nodes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_META_UNKNOWN_KEY | walks | 16 | 0 | 16 | 0 | 0 |  |
| MOV_NAME_UNRESOLVED | names | 246 | 246 | 0 | 0 | 0 | yes |
| MOV_NARROWING | walks | 84 | 0 | 84 | 0 | 0 |  |
| MOV_NESTED_CALL_SUSPENDS | calls | 6 | 0 | 6 | 0 | 0 |  |
| MOV_NODE_ARG_SHAPE | nodes | 77 | 0 | 77 | 0 | 0 |  |
| MOV_NODE_EDGE_DEFERRED | nodes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_NODE_EDGE_UNDECLARED | nodes | 24 | 0 | 24 | 0 | 0 |  |
| MOV_NODE_ENTRY_DUPLICATE | nodes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_NODE_ENTRY_NODE_VALUE | nodes | 16 | 0 | 16 | 0 | 0 |  |
| MOV_NODE_ENTRY_TYPE | nodes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_NODE_LANDING_MISMATCH | nodes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_NODE_LINK_BODY | nodes | 2 | 0 | 2 | 0 | 0 |  |
| MOV_NODE_LINK_SHAPE | nodes | 32 | 0 | 32 | 0 | 0 |  |
| MOV_OPTION_INVALID | systems | 11 | 0 | 11 | 0 | 0 |  |
| MOV_ORDER_KEY_IMPURE | values | 4 | 0 | 4 | 0 | 0 |  |
| MOV_ORDER_KEY_MULTI | values | 4 | 0 | 4 | 0 | 0 |  |
| MOV_PARALLEL_RETIRED | closures | 14 | 0 | 14 | 0 | 0 |  |
| MOV_PARAM_NEEDS_TYPE | calls | 13 | 0 | 13 | 0 | 0 |  |
| MOV_PARENT_READ_RETIRED | walks | 8 | 0 | 8 | 0 | 0 |  |
| MOV_PLUGIN_ARGS_NAMED | calls | 2 | 0 | 2 | 0 | 0 |  |
| MOV_PLUGIN_FED_BY_EXTRACTION | extraction | 8 | 0 | 8 | 0 | 0 |  |
| MOV_PLUGIN_OUTPUT_CHANGED | versions | 2 | 0 | 2 | 0 | 0 |  |
| MOV_PLUGIN_OUTPUT_UNDECLARED | calls | 4 | 0 | 4 | 0 | 0 |  |
| MOV_PLUGIN_ROW_UNDECLARED | calls | 4 | 0 | 4 | 0 | 0 |  |
| MOV_PRESENCE_TEST_CONSTANT | values | 19 | 0 | 19 | 0 | 0 |  |
| MOV_PRESENCE_TEST_ON_TEXT | values | 52 | 0 | 52 | 0 | 0 |  |
| MOV_READ_NOT_FILE | extraction | 8 | 0 | 8 | 0 | 0 |  |
| MOV_REBOUND_NAME | names | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_RECORD_NOT_A_VALUE | records | 29 | 0 | 29 | 0 | 0 |  |
| MOV_RECURSIVE_RETURN_TYPE | calls | 8 | 0 | 8 | 0 | 0 |  |
| MOV_REFRESH_UNSTABLE | writes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_RESERVED_NAME | names | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_RESOURCES_NOT_EXTRACTED | extraction | 24 | 0 | 24 | 0 | 0 |  |
| MOV_RESOURCE_READ_RETIRED | extraction | 14 | 0 | 14 | 0 | 0 |  |
| MOV_RESOURCE_WALK_UNREAD | extraction | 6 | 0 | 6 | 0 | 0 |  |
| MOV_RETURN_NOT_A_VALUE | calls | 4 | 0 | 4 | 0 | 0 |  |
| MOV_RETURN_OUTSIDE_BODY | calls | 4 | 0 | 4 | 0 | 0 |  |
| MOV_RETURN_PLANE_MISMATCH | calls | 4 | 0 | 4 | 0 | 0 |  |
| MOV_RETURN_TYPE | calls | 12 | 0 | 12 | 0 | 0 |  |
| MOV_SHADOWED_NAME | names | 36 | 36 | 0 | 0 | 0 | yes |
| MOV_SHAPE_HOP_RETIRED | walks | 8 | 0 | 8 | 0 | 0 |  |
| MOV_SORT_KEY_ON_SCALAR | values | 4 | 0 | 4 | 0 | 0 |  |
| MOV_SORT_KEY_ON_WALK | values | 8 | 0 | 8 | 0 | 0 |  |
| MOV_SORT_NEEDS_KEY | values | 8 | 0 | 8 | 0 | 0 |  |
| MOV_SORT_NOT_COLLECTION | values | 4 | 0 | 4 | 0 | 0 |  |
| MOV_STDLIB_ARG_INVALID | calls | 23 | 0 | 23 | 0 | 0 |  |
| MOV_STDLIB_ARG_LAZY_EDGE | records | 4 | 0 | 4 | 0 | 0 |  |
| MOV_STDLIB_ARG_NOT_LITERAL | calls | 17 | 0 | 17 | 0 | 0 |  |
| MOV_STDLIB_ARG_NOT_RECORD | records | 26 | 0 | 26 | 0 | 0 |  |
| MOV_TARGET_WHERE_BIND | writes | 2 | 0 | 2 | 0 | 0 |  |
| MOV_TARGET_WHERE_LOCAL | writes | 3 | 0 | 3 | 0 | 0 |  |
| MOV_TARGET_WHERE_NOT_FINAL | writes | 3 | 0 | 3 | 0 | 0 |  |
| MOV_THROUGH_ARG_MISSING | extraction | 12 | 0 | 12 | 0 | 0 |  |
| MOV_THROUGH_BAD_ARG | extraction | 12 | 0 | 12 | 0 | 0 |  |
| MOV_THROUGH_FORWARD_REF | extraction | 7 | 0 | 7 | 0 | 0 |  |
| MOV_THROUGH_NOT_PLUGIN | extraction | 4 | 0 | 4 | 0 | 0 |  |
| MOV_TRANSFORM_HOP_RETIRED | walks | 8 | 0 | 8 | 0 | 0 |  |
| MOV_TRAVERSE_UNKNOWN_EDGE | walks | 111 | 0 | 111 | 0 | 0 |  |
| MOV_UNDESCRIBED_POSITION | walks | 8 | 0 | 8 | 0 | 0 |  |
| MOV_UNIQUE_CONJUNCT_NEEDS_WHERE | writes | 18 | 0 | 18 | 0 | 0 |  |
| MOV_UNIQUE_FUZZY_UNSUPPORTED | writes | 13 | 0 | 13 | 0 | 0 |  |
| MOV_UNIQUE_KEY_MAY_BE_BLANK | writes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_UNIQUE_NATIVE_REDUNDANT | writes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_UNIQUE_NOT_AUTHORABLE | writes | 10 | 0 | 10 | 0 | 0 |  |
| MOV_UNIQUE_UNKNOWN_FIELD | writes | 31 | 0 | 31 | 0 | 0 |  |
| MOV_UNKNOWN_POSITION | walks | 56 | 0 | 56 | 0 | 0 |  |
| MOV_UNKNOWN_PROPERTY | walks | 286 | 0 | 286 | 0 | 0 |  |
| MOV_UNKNOWN_TYPE_NAME | nodes | 23 | 0 | 23 | 0 | 0 |  |
| MOV_UNREACHABLE_BRANCH | walks | 28 | 0 | 28 | 0 | 0 |  |
| MOV_UNTIL_CADENCE_TOO_SHORT | flow | 4 | 0 | 4 | 0 | 0 |  |
| MOV_UNTIL_EDGE_WATCHABLE | flow | 4 | 0 | 4 | 0 | 0 |  |
| MOV_USE_BEFORE_BIND | names | 19 | 15 | 4 | 0 | 0 |  |
| MOV_VALUE_UNLISTED | values | 20 | 0 | 20 | 0 | 0 |  |
| MOV_WAIT_NOT_RESUMABLE | flow | 12 | 0 | 12 | 0 | 0 |  |
| MOV_WRITE_APPEND_NOT_MULTI | writes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_WRITE_BIND_NOT_RECORD | writes | 3 | 0 | 3 | 0 | 0 |  |
| MOV_WRITE_BIND_NO_UPDATE | writes | 5 | 0 | 5 | 0 | 0 |  |
| MOV_WRITE_BIND_POSITION | writes | 3 | 0 | 3 | 0 | 0 |  |
| MOV_WRITE_BIND_RETIRED | writes | 9 | 0 | 9 | 0 | 0 |  |
| MOV_WRITE_BIND_UNIQUE | writes | 3 | 0 | 3 | 0 | 0 |  |
| MOV_WRITE_DISCRIMINANT_NOT_LITERAL | writes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_WRITE_EPHEMERAL_BOUND | writes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_WRITE_FIELD_TYPE | writes | 75 | 0 | 75 | 0 | 0 |  |
| MOV_WRITE_GENERIC_NOT_LITERAL | writes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_WRITE_LINK_FIELD_NUDGE | writes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_WRITE_MAY_BE_EMPTY | writes | 101 | 0 | 101 | 0 | 0 |  |
| MOV_WRITE_MISSING_REQUIRED_EDGE | writes | 12 | 0 | 12 | 0 | 0 |  |
| MOV_WRITE_MISSING_REQUIRED_FIELD | writes | 43 | 0 | 43 | 0 | 0 |  |
| MOV_WRITE_ONLY_EDGE | writes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_WRITE_ONLY_PROPERTY | writes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_WRITE_POSITION_NOT_RECORD | writes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_WRITE_POSITION_NO_UPDATE | writes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_WRITE_POSITION_UNIQUE | writes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_WRITE_READ_ONLY_EDGE | writes | 35 | 0 | 35 | 0 | 0 |  |
| MOV_WRITE_SHAPE_RETIRED | writes | 8 | 0 | 8 | 0 | 0 |  |
| MOV_WRITE_SPREAD_SOURCE | writes | 3 | 0 | 3 | 0 | 0 |  |
| MOV_WRITE_TARGET_NOT_GRAPH | writes | 16 | 0 | 16 | 0 | 0 |  |
| MOV_WRITE_TUPLE_MISMATCH | writes | 4 | 0 | 4 | 0 | 0 |  |
| MOV_WRITE_UNION_UNSATISFIED | writes | 20 | 0 | 20 | 0 | 0 |  |
| MOV_WRITE_UNKNOWN_FIELD | writes | 77 | 0 | 77 | 0 | 0 |  |
