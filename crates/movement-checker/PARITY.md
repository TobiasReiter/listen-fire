# Checker parity: Rust against TypeScript

Written by `crates/movement-checker/parity/run.sh`. Do not edit by hand.

- Codes at parity: **255 of 255** codes the TypeScript checker reports on this corpus.
- Diagnostics matched: 170073 of 170073; 0 extra in Rust.
- Records with exactly the TypeScript's diagnostics, in its order: 44891 of 44891.
- Rust side: 40.8s; 0 records the Rust parser or catalog refused; 0 panics; 0 checks that did not finish (refused.txt names them).

A code is at parity when every diagnostic of it on the corpus is matched exactly and Rust reports none extra.

| corpus | records | exact | same diagnostics, any order |
|---|---|---|---|
| checks under v5 | 7493 | 7493 | 7493 |
| checks v1 | 2573 | 2573 | 2573 |
| checks v2 | 2904 | 2904 | 2904 |
| checks v3 | 3619 | 3619 | 3619 |
| checks v4 | 6922 | 6922 | 6922 |
| checks v5 | 17418 | 17418 | 17418 |
| checks v99 | 9 | 9 | 9 |
| oracle handles | 981 | 981 | 981 |
| oracle parallel | 398 | 398 | 398 |
| oracle patterns | 404 | 404 | 404 |
| oracle patterns under v5 | 373 | 373 | 373 |
| oracle records | 1797 | 1797 | 1797 |

## By family

| family | codes seen | at parity | TS diagnostics | matched | missing | extra | message differs |
|---|---|---|---|---|---|---|---|
| (not in PORT.md) | 11 | 11 | 117757 | 117757 | 0 | 0 | 0 |
| calls | 29 | 29 | 2075 | 2075 | 0 | 0 | 0 |
| closures | 15 | 15 | 1836 | 1836 | 0 | 0 | 0 |
| extraction | 20 | 20 | 608 | 608 | 0 | 0 | 0 |
| flow | 10 | 10 | 110 | 110 | 0 | 0 | 0 |
| imports | 5 | 5 | 68 | 68 | 0 | 0 | 0 |
| listens | 12 | 12 | 38401 | 38401 | 0 | 0 | 0 |
| names | 11 | 11 | 1018 | 1018 | 0 | 0 | 0 |
| nodes | 28 | 28 | 807 | 807 | 0 | 0 | 0 |
| records | 12 | 12 | 1150 | 1150 | 0 | 0 | 0 |
| systems | 8 | 8 | 185 | 185 | 0 | 0 | 0 |
| values | 22 | 22 | 2520 | 2520 | 0 | 0 | 0 |
| versions | 2 | 2 | 13 | 13 | 0 | 0 | 0 |
| walks | 22 | 22 | 1330 | 1330 | 0 | 0 | 0 |
| writes | 48 | 48 | 2195 | 2195 | 0 | 0 | 0 |

## By code

| code | family | TS | matched | missing in Rust | extra in Rust | message differs | parity |
|---|---|---|---|---|---|---|---|
| MOV_ABSENT_REQUIRED | values | 974 | 974 | 0 | 0 | 0 | yes |
| MOV_ADAPTER_NOT_CONSTRUCTED | systems | 42 | 42 | 0 | 0 | 0 | yes |
| MOV_AI_TIER_LEGACY | systems | 43 | 43 | 0 | 0 | 0 | yes |
| MOV_AMBIGUOUS_PROPERTY | walks | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_ARITH_NON_NUMERIC | values | 143 | 143 | 0 | 0 | 0 | yes |
| MOV_ARTIFICIAL_EDGE_UNKNOWN | walks | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_AT_RECORD_KEY | records | 72 | 72 | 0 | 0 | 0 | yes |
| MOV_AWAIT_BAD_DURATION | flow | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_AWAIT_BARE_WALK | flow | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_AWAIT_IMPURE_CONDITION | flow | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_AWAIT_NEEDS_CADENCE | flow | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_AWAIT_NOT_AWAITABLE | flow | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_BLOCK_READ_BACK_RETIRED | closures | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_BLOCK_RETURNS_NOTHING | closures | 228 | 228 | 0 | 0 | 0 | yes |
| MOV_BORROW_UNKNOWN_FIELD | nodes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_BORROW_UNKNOWN_GRAPH | nodes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_BORROW_UNKNOWN_ROOT | nodes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_BUILTIN_ARGS | calls | 32 | 32 | 0 | 0 | 0 | yes |
| MOV_BUILTIN_ARG_TYPE | calls | 33 | 33 | 0 | 0 | 0 | yes |
| MOV_BUILTIN_NOT_RUN | calls | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_BUILTIN_UNUSED | calls | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_CALLBACK_BAD_CONFIG | listens | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_CALLBACK_NOT_MOVEMENT | listens | 15 | 15 | 0 | 0 | 0 | yes |
| MOV_CALLBACK_PARAM_NOT_VALUE | listens | 20 | 20 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_DUPLICATE | calls | 13 | 13 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_MAYBE_RECORD | records | 341 | 341 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_MISSING | calls | 45 | 45 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_OPAQUE_RECORD | records | 364 | 364 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_TYPE | calls | 1066 | 1066 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_UNKNOWN | calls | 28 | 28 | 0 | 0 | 0 | yes |
| MOV_CALL_ARITY | calls | 59 | 59 | 0 | 0 | 0 | yes |
| MOV_CALL_CLOSURE_RETURNS | calls | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_CALL_NESTED | calls | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_CALL_NOT_MOVEMENT | calls | 43 | 43 | 0 | 0 | 0 | yes |
| MOV_CALL_RETURNS_NOTHING | calls | 28 | 28 | 0 | 0 | 0 | yes |
| MOV_CHUNKS_NOT_TEXT | extraction | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_CLOSURE_NOT_DATA | closures | 187 | 187 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_ARITY | closures | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_CONFIG | closures | 35 | 35 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_NOT_A_COLLECTION | closures | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_RETURNS_NOTHING | closures | 20 | 20 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_SUSPENDS | closures | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_ARMS_ARE_ARGUMENTS | closures | 272 | 272 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_ARM_NOT_FUNCTION | closures | 117 | 117 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_ARM_TAKES_NOTHING | closures | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_NEEDS_AWAIT | closures | 11 | 11 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_NO_AWAIT | closures | 302 | 302 | 0 | 0 | 0 | yes |
| MOV_COMPARE_TYPE_MISMATCH | values | 96 | 96 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_BAD_ARG | systems | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_MISSING_CRED | systems | 11 | 11 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_NOT_ADAPTER | systems | 22 | 22 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_UNKNOWN_OPTION | systems | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_COUNT_COUNTS_EMPTY | ? | 7 | 7 | 0 | 0 | 0 | yes |
| MOV_CREDENTIAL_NOT_A_VALUE | names | 125 | 125 | 0 | 0 | 0 | yes |
| MOV_CRED_WRONG_ADAPTER | systems | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_DELETE_NOT_DECLARED | writes | 35 | 35 | 0 | 0 | 0 | yes |
| MOV_DELETE_NOT_RECORD | writes | 29 | 29 | 0 | 0 | 0 | yes |
| MOV_DICT_KEY_NOT_TEXT | values | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_DICT_UNKNOWN_KEY | values | 39 | 39 | 0 | 0 | 0 | yes |
| MOV_DUPLICATE_DECL | names | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_ENUM_EMPTY_DOMAIN | values | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_ENUM_UNKNOWN_VALUE | values | 186 | 186 | 0 | 0 | 0 | yes |
| MOV_EVENT_UNDESCRIBED | ? | 207 | 207 | 0 | 0 | 0 | yes |
| MOV_EXPR_CLOSURE_POSITION | calls | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_EXPR_PARSE | calls | 359 | 359 | 0 | 0 | 0 | yes |
| MOV_EXTENDS_CYCLE | nodes | 15 | 15 | 0 | 0 | 0 | yes |
| MOV_EXTENDS_NOT_A_NODE | nodes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_EXTENDS_REDEFINES | nodes | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_ANNOTATE | extraction | 31 | 31 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_CALL_NESTED | extraction | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_CONFIG | extraction | 34 | 34 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_CONTENT | extraction | 141 | 141 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_FIELD_DUPLICATE | extraction | 20 | 20 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_KEYWORD_RETIRED | ? | 1446 | 1446 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_NEEDS_ANNOTATION | extraction | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_SHAPE_COMPUTED | extraction | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_SHAPE_NOT_DECLARED | extraction | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_TYPE_CONFLICT | extraction | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_UNKNOWN_FIELD | extraction | 34 | 34 | 0 | 0 | 0 | yes |
| MOV_FILE_IN_TEXT | records | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_FOLD_NEEDS_ORDER | values | 167 | 167 | 0 | 0 | 0 | yes |
| MOV_FUNCTION_NAME_COLLISION | names | 9 | 9 | 0 | 0 | 0 | yes |
| MOV_FUNCTION_UNKNOWN | calls | 83 | 83 | 0 | 0 | 0 | yes |
| MOV_GRAPH_ENTRY_KIND | nodes | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_GRAPH_ENTRY_RECORD | nodes | 162 | 162 | 0 | 0 | 0 | yes |
| MOV_GRAPH_FIELD_MISSING | nodes | 34 | 34 | 0 | 0 | 0 | yes |
| MOV_GRAPH_FIELD_TYPE | nodes | 25 | 25 | 0 | 0 | 0 | yes |
| MOV_GRAPH_FIELD_UNKNOWN | nodes | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_GRAPH_REFERENCE_SHAPE | nodes | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_GRAPH_SHAPE | nodes | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_GRAPH_SPREAD_NOT_MAP | nodes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_GRAPH_SPREAD_RECORD | nodes | 71 | 71 | 0 | 0 | 0 | yes |
| MOV_GRAPH_SPREAD_UNTYPED | nodes | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_HANDLE_FIELD_RETIRED | records | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_HANDLE_FILE_NOT_SENT | records | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_HANDLE_READ_FOUND | records | 3 | 3 | 0 | 0 | 0 | yes |
| MOV_HANDLE_UPDATED_IN_PLACE | writes | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_HEAD_NEEDS_A_NAME | flow | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_HEAD_NOT_A_POSITION | walks | 38 | 38 | 0 | 0 | 0 | yes |
| MOV_HOP_CONFIG_UNREAD | walks | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_HOP_FILTER_ENGINE | walks | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_HOP_FILTER_RESIDUAL | walks | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_HOP_FILTER_UNSUPPORTED | walks | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_HOP_ORDER_ENGINE | walks | 82 | 82 | 0 | 0 | 0 | yes |
| MOV_HOP_ORDER_UNSUPPORTED | walks | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_IF_WITHOUT_ELSE | flow | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_IMPORT_CYCLE | imports | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_IMPORT_DUPLICATE | names | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_INVALID | imports | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_UNRESOLVED | imports | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_UNSUPPORTED | imports | 20 | 20 | 0 | 0 | 0 | yes |
| MOV_IMPORT_NOT_EXPORTED | imports | 30 | 30 | 0 | 0 | 0 | yes |
| MOV_IMPORT_UNKNOWN | names | 175 | 175 | 0 | 0 | 0 | yes |
| MOV_INLINE_BLOCK_RETIRED | closures | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_INTERNAL_UNTYPED_BINDING | records | 3 | 3 | 0 | 0 | 0 | yes |
| MOV_IN_MEMORY_HOP_ORDER | ? | 344 | 344 | 0 | 0 | 0 | yes |
| MOV_JSON_OPAQUE | values | 224 | 224 | 0 | 0 | 0 | yes |
| MOV_LANGUAGE_VERSION_UNSUPPORTED | versions | 11 | 11 | 0 | 0 | 0 | yes |
| MOV_LIMIT_NEEDS_ORDER | walks | 14 | 14 | 0 | 0 | 0 | yes |
| MOV_LINKED_HOP_RETIRED | writes | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_LINKED_NEEDS_TYPE | writes | 39 | 39 | 0 | 0 | 0 | yes |
| MOV_LINKED_TYPE_MISMATCH | writes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_LINKED_UNKNOWN_EDGE | writes | 71 | 71 | 0 | 0 | 0 | yes |
| MOV_LINK_MATCH_BODY_RETIRED | writes | 39 | 39 | 0 | 0 | 0 | yes |
| MOV_LINK_UNSUPPORTED_EDGE | writes | 19 | 19 | 0 | 0 | 0 | yes |
| MOV_LISTEN_ALIAS_DUPLICATE | listens | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_LISTEN_BAD_CONFIG | listens | 210 | 210 | 0 | 0 | 0 | yes |
| MOV_LISTEN_CANNOT_FIRE | listens | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_LISTEN_DUPLICATE | listens | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_LISTEN_FILE_LEVEL | listens | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_LISTEN_MISSING | listens | 37825 | 37825 | 0 | 0 | 0 | yes |
| MOV_LISTEN_NOT_INSTANCE | listens | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_LISTEN_PARAM_MISMATCH | listens | 221 | 221 | 0 | 0 | 0 | yes |
| MOV_LISTEN_SHAPE_MISMATCH | listens | 38 | 38 | 0 | 0 | 0 | yes |
| MOV_LIST_MIXED | values | 55 | 55 | 0 | 0 | 0 | yes |
| MOV_LIST_SPREAD_NOT_A_LIST | values | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_MAP_KEY_OVERWRITTEN | values | 13 | 13 | 0 | 0 | 0 | yes |
| MOV_MAP_SPREAD_NOT_KEYED | values | 77 | 77 | 0 | 0 | 0 | yes |
| MOV_MATCH_MISS_CONTINUES | writes | 1 | 1 | 0 | 0 | 0 | yes |
| MOV_MATCH_NO_IDENTITY | writes | 19 | 19 | 0 | 0 | 0 | yes |
| MOV_MATCH_UNNAMED | writes | 40 | 40 | 0 | 0 | 0 | yes |
| MOV_MEMBERS_NOT_CLOSED | nodes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_META_HOP_RETIRED | walks | 42 | 42 | 0 | 0 | 0 | yes |
| MOV_META_UNKNOWN_KEY | walks | 28 | 28 | 0 | 0 | 0 | yes |
| MOV_NAME_PROTO | names | 104 | 104 | 0 | 0 | 0 | yes |
| MOV_NAME_UNRESOLVED | names | 444 | 444 | 0 | 0 | 0 | yes |
| MOV_NARROWING | walks | 126 | 126 | 0 | 0 | 0 | yes |
| MOV_NESTED_CALL_SUSPENDS | calls | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_NODE_ARG_SHAPE | nodes | 117 | 117 | 0 | 0 | 0 | yes |
| MOV_NODE_EDGE_DEFERRED | nodes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_NODE_EDGE_UNDECLARED | nodes | 54 | 54 | 0 | 0 | 0 | yes |
| MOV_NODE_ENTRY_DUPLICATE | nodes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_NODE_ENTRY_NODE_VALUE | nodes | 27 | 27 | 0 | 0 | 0 | yes |
| MOV_NODE_ENTRY_TYPE | nodes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_NODE_LANDING_MISMATCH | nodes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_NODE_LINK_BODY | nodes | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_NODE_LINK_SHAPE | nodes | 48 | 48 | 0 | 0 | 0 | yes |
| MOV_OLD_EDGE_NOT_A_WRITE | walks | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_OPTION_INVALID | systems | 17 | 17 | 0 | 0 | 0 | yes |
| MOV_ORDER_KEY_IMPURE | values | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_ORDER_KEY_MULTI | values | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_PARALLEL_RETIRED | closures | 594 | 594 | 0 | 0 | 0 | yes |
| MOV_PARAM_NEEDS_TYPE | calls | 46 | 46 | 0 | 0 | 0 | yes |
| MOV_PARENT_READ_RETIRED | walks | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_ARGS_NAMED | calls | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_FED_BY_EXTRACTION | extraction | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_OUTPUT_CHANGED | versions | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_OUTPUT_UNDECLARED | calls | 33 | 33 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_ROW_UNDECLARED | calls | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_PRESENCE_OF_RETURNED | ? | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_PRESENCE_TEST_CONSTANT | values | 300 | 300 | 0 | 0 | 0 | yes |
| MOV_PRESENCE_TEST_ON_TEXT | values | 95 | 95 | 0 | 0 | 0 | yes |
| MOV_READ_NOT_FILE | extraction | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_REBOUND_NAME | names | 17 | 17 | 0 | 0 | 0 | yes |
| MOV_RECEIPT_RECORD_SLOT | records | 75 | 75 | 0 | 0 | 0 | yes |
| MOV_RECORD_NOT_A_VALUE | records | 58 | 58 | 0 | 0 | 0 | yes |
| MOV_RECURSIVE_RETURN_TYPE | calls | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_REFRESH_UNSTABLE | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_RESERVED_NAME | names | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_RESOURCES_NOT_EXTRACTED | extraction | 130 | 130 | 0 | 0 | 0 | yes |
| MOV_RESOURCE_READ_RETIRED | extraction | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_RESOURCE_WALK_UNREAD | extraction | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_RETURN_NOT_A_VALUE | calls | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_RETURN_OUTSIDE_BODY | calls | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_RETURN_PLANE_MISMATCH | calls | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_RETURN_TYPE | calls | 43 | 43 | 0 | 0 | 0 | yes |
| MOV_SHADOWED_NAME | names | 67 | 67 | 0 | 0 | 0 | yes |
| MOV_SHAPE_FIELD_PROTO | nodes | 42 | 42 | 0 | 0 | 0 | yes |
| MOV_SHAPE_HOP_RETIRED | walks | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_SORT_KEY_ON_SCALAR | values | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_SORT_KEY_ON_WALK | values | 13 | 13 | 0 | 0 | 0 | yes |
| MOV_SORT_NEEDS_KEY | values | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_SORT_NOT_COLLECTION | values | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_STDLIB_ARG_INVALID | calls | 35 | 35 | 0 | 0 | 0 | yes |
| MOV_STDLIB_ARG_LAZY_EDGE | records | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_STDLIB_ARG_NOT_LITERAL | calls | 26 | 26 | 0 | 0 | 0 | yes |
| MOV_STDLIB_ARG_NOT_RECORD | records | 198 | 198 | 0 | 0 | 0 | yes |
| MOV_TARGET_WHERE_BIND | writes | 3 | 3 | 0 | 0 | 0 | yes |
| MOV_TARGET_WHERE_LOCAL | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_TARGET_WHERE_NOT_FINAL | writes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_TEXT_HAS_NO_FIELDS | ? | 42 | 42 | 0 | 0 | 0 | yes |
| MOV_THROUGH_ARG_MISSING | extraction | 35 | 35 | 0 | 0 | 0 | yes |
| MOV_THROUGH_BAD_ARG | extraction | 33 | 33 | 0 | 0 | 0 | yes |
| MOV_THROUGH_FORWARD_REF | extraction | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_THROUGH_NOT_PLUGIN | extraction | 7 | 7 | 0 | 0 | 0 | yes |
| MOV_TRANSFORM_HOP_RETIRED | walks | 36 | 36 | 0 | 0 | 0 | yes |
| MOV_TRAVERSE_UNKNOWN_EDGE | walks | 203 | 203 | 0 | 0 | 0 | yes |
| MOV_TYPE_TOO_LARGE | calls | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_UNDESCRIBED_POSITION | walks | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_CONJUNCT_NEEDS_WHERE | writes | 46 | 46 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_FUZZY_UNSUPPORTED | writes | 25 | 25 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_KEY_MAY_BE_BLANK | writes | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_NATIVE_REDUNDANT | writes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_NOT_AUTHORABLE | writes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_UNKNOWN_FIELD | writes | 49 | 49 | 0 | 0 | 0 | yes |
| MOV_UNKNOWN_POSITION | walks | 84 | 84 | 0 | 0 | 0 | yes |
| MOV_UNKNOWN_PROPERTY | walks | 489 | 489 | 0 | 0 | 0 | yes |
| MOV_UNKNOWN_TYPE_NAME | nodes | 37 | 37 | 0 | 0 | 0 | yes |
| MOV_UNREACHABLE_BRANCH | walks | 42 | 42 | 0 | 0 | 0 | yes |
| MOV_UNTIL_CADENCE_TOO_SHORT | flow | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_UNTIL_EDGE_WATCHABLE | flow | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_USE_BEFORE_BIND | names | 29 | 29 | 0 | 0 | 0 | yes |
| MOV_V5_HIDES_BUILTIN | ? | 248 | 248 | 0 | 0 | 0 | yes |
| MOV_V5_IMPORT_NEEDS_ALIAS | ? | 1 | 1 | 0 | 0 | 0 | yes |
| MOV_V5_NOT_YET | ? | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_V5_SPELLING | ? | 115449 | 115449 | 0 | 0 | 0 | yes |
| MOV_V5_UNKNOWN_MEMBER | ? | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_VALUE_UNLISTED | values | 40 | 40 | 0 | 0 | 0 | yes |
| MOV_WAIT_NOT_RESUMABLE | flow | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_WRITE_APPEND_NOT_MULTI | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_NOT_RECORD | writes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_NO_UPDATE | writes | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_POSITION | writes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_RETIRED | writes | 44 | 44 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_UNIQUE | writes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_WRITE_DISCRIMINANT_NOT_LITERAL | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_WRITE_EPHEMERAL_BOUND | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_WRITE_FIELD_TYPE | writes | 723 | 723 | 0 | 0 | 0 | yes |
| MOV_WRITE_GENERIC_NOT_LITERAL | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_LINK_FIELD_NUDGE | writes | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_WRITE_MAY_BE_EMPTY | writes | 194 | 194 | 0 | 0 | 0 | yes |
| MOV_WRITE_MISSING_REQUIRED_EDGE | writes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_WRITE_MISSING_REQUIRED_FIELD | writes | 66 | 66 | 0 | 0 | 0 | yes |
| MOV_WRITE_ONLY_EDGE | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_ONLY_PROPERTY | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_POSITION_NOT_RECORD | writes | 45 | 45 | 0 | 0 | 0 | yes |
| MOV_WRITE_POSITION_NO_UPDATE | writes | 14 | 14 | 0 | 0 | 0 | yes |
| MOV_WRITE_POSITION_UNIQUE | writes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_WRITE_READ_ONLY_EDGE | writes | 62 | 62 | 0 | 0 | 0 | yes |
| MOV_WRITE_SHAPE_RETIRED | writes | 32 | 32 | 0 | 0 | 0 | yes |
| MOV_WRITE_SPREAD_SOURCE | writes | 127 | 127 | 0 | 0 | 0 | yes |
| MOV_WRITE_TARGET_NOT_GRAPH | writes | 25 | 25 | 0 | 0 | 0 | yes |
| MOV_WRITE_TUPLE_MISMATCH | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_UNION_UNSATISFIED | writes | 30 | 30 | 0 | 0 | 0 | yes |
| MOV_WRITE_UNKNOWN_FIELD | writes | 188 | 188 | 0 | 0 | 0 | yes |
