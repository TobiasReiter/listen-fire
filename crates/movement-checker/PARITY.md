# Checker parity: Rust against TypeScript

Written by `crates/movement-checker/parity/run.sh`. Do not edit by hand.

- Codes at parity: **231 of 242** codes the TypeScript checker reports on this corpus.
- Diagnostics matched: 35062 of 35347; 237 extra in Rust.
- Records with exactly the TypeScript's diagnostics, in its order: 27818 of 28328.
- Rust side: 44.2s; 0 records the Rust parser or catalog refused; 0 panics; 0 checks that did not finish (refused.txt names them).

A code is at parity when every diagnostic of it on the corpus is matched exactly and Rust reports none extra.

| corpus | records | exact | same diagnostics, any order |
|---|---|---|---|
| checks under v5 | 5805 | 5685 | 5689 |
| checks v1 | 2246 | 2185 | 2186 |
| checks v2 | 2544 | 2533 | 2534 |
| checks v3 | 3339 | 3258 | 3262 |
| checks v4 | 5450 | 5322 | 5326 |
| checks v5 | 5759 | 5650 | 5657 |
| checks v99 | 9 | 9 | 9 |
| oracle handles | 981 | 981 | 981 |
| oracle parallel | 398 | 398 | 398 |
| oracle records | 1797 | 1797 | 1797 |

## By family

| family | codes seen | at parity | TS diagnostics | matched | missing | extra | message differs |
|---|---|---|---|---|---|---|---|
| calls | 28 | 26 | 1646 | 1621 | 22 | 0 | 3 |
| closures | 15 | 15 | 885 | 885 | 0 | 0 | 0 |
| extraction | 20 | 19 | 439 | 357 | 82 | 0 | 0 |
| flow | 10 | 10 | 108 | 108 | 0 | 0 | 0 |
| imports | 5 | 5 | 66 | 66 | 0 | 0 | 0 |
| listens | 12 | 12 | 24305 | 24305 | 0 | 0 | 0 |
| names | 11 | 11 | 780 | 780 | 0 | 0 | 0 |
| nodes | 28 | 26 | 712 | 691 | 21 | 59 | 0 |
| records | 11 | 10 | 810 | 786 | 24 | 4 | 0 |
| systems | 8 | 8 | 166 | 166 | 0 | 0 | 0 |
| values | 22 | 21 | 2272 | 2266 | 6 | 0 | 0 |
| versions | 2 | 2 | 11 | 11 | 0 | 0 | 0 |
| walks | 22 | 22 | 1201 | 1201 | 0 | 0 | 0 |
| writes | 48 | 44 | 1946 | 1819 | 78 | 174 | 49 |

## By code

| code | family | TS | matched | missing in Rust | extra in Rust | message differs | parity |
|---|---|---|---|---|---|---|---|
| MOV_ABSENT_REQUIRED | values | 906 | 906 | 0 | 0 | 0 | yes |
| MOV_ADAPTER_NOT_CONSTRUCTED | systems | 42 | 42 | 0 | 0 | 0 | yes |
| MOV_AI_TIER_LEGACY | systems | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_AMBIGUOUS_PROPERTY | walks | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_ARITH_NON_NUMERIC | values | 127 | 127 | 0 | 0 | 0 | yes |
| MOV_ARTIFICIAL_EDGE_UNKNOWN | walks | 3 | 3 | 0 | 0 | 0 | yes |
| MOV_AT_RECORD_KEY | records | 57 | 57 | 0 | 0 | 0 | yes |
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
| MOV_BUILTIN_ARGS | calls | 22 | 22 | 0 | 0 | 0 | yes |
| MOV_BUILTIN_ARG_TYPE | calls | 28 | 28 | 0 | 0 | 0 | yes |
| MOV_BUILTIN_NOT_RUN | calls | 7 | 7 | 0 | 0 | 0 | yes |
| MOV_BUILTIN_UNUSED | calls | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_CALLBACK_BAD_CONFIG | listens | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_CALLBACK_NOT_MOVEMENT | listens | 14 | 14 | 0 | 0 | 0 | yes |
| MOV_CALLBACK_PARAM_NOT_VALUE | listens | 22 | 22 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_DUPLICATE | calls | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_MAYBE_RECORD | records | 99 | 75 | 24 | 4 | 0 |  |
| MOV_CALL_ARG_MISSING | calls | 43 | 43 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_OPAQUE_RECORD | records | 364 | 364 | 0 | 0 | 0 | yes |
| MOV_CALL_ARG_TYPE | calls | 955 | 931 | 21 | 0 | 3 |  |
| MOV_CALL_ARG_UNKNOWN | calls | 28 | 28 | 0 | 0 | 0 | yes |
| MOV_CALL_ARITY | calls | 42 | 42 | 0 | 0 | 0 | yes |
| MOV_CALL_CLOSURE_RETURNS | calls | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_CALL_NESTED | calls | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_CALL_NOT_MOVEMENT | calls | 22 | 22 | 0 | 0 | 0 | yes |
| MOV_CALL_RETURNS_NOTHING | calls | 28 | 28 | 0 | 0 | 0 | yes |
| MOV_CHUNKS_NOT_TEXT | extraction | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_CLOSURE_NOT_DATA | closures | 87 | 87 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_ARITY | closures | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_CONFIG | closures | 31 | 31 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_NOT_A_COLLECTION | closures | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_RETURNS_NOTHING | closures | 20 | 20 | 0 | 0 | 0 | yes |
| MOV_COLLECTION_OP_SUSPENDS | closures | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_ARMS_ARE_ARGUMENTS | closures | 95 | 95 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_ARM_NOT_FUNCTION | closures | 37 | 37 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_ARM_TAKES_NOTHING | closures | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_NEEDS_AWAIT | closures | 11 | 11 | 0 | 0 | 0 | yes |
| MOV_COMBINATOR_NO_AWAIT | closures | 115 | 115 | 0 | 0 | 0 | yes |
| MOV_COMPARE_TYPE_MISMATCH | values | 92 | 92 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_BAD_ARG | systems | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_MISSING_CRED | systems | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_NOT_ADAPTER | systems | 21 | 21 | 0 | 0 | 0 | yes |
| MOV_CONSTRUCT_UNKNOWN_OPTION | systems | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_CREDENTIAL_NOT_A_VALUE | names | 122 | 122 | 0 | 0 | 0 | yes |
| MOV_CRED_WRONG_ADAPTER | systems | 26 | 26 | 0 | 0 | 0 | yes |
| MOV_DELETE_NOT_DECLARED | writes | 11 | 11 | 0 | 0 | 0 | yes |
| MOV_DELETE_NOT_RECORD | writes | 11 | 11 | 0 | 0 | 0 | yes |
| MOV_DICT_KEY_NOT_TEXT | values | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_DICT_UNKNOWN_KEY | values | 39 | 39 | 0 | 0 | 0 | yes |
| MOV_DUPLICATE_DECL | names | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_ENUM_EMPTY_DOMAIN | values | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_ENUM_UNKNOWN_VALUE | values | 192 | 192 | 0 | 0 | 0 | yes |
| MOV_EXPR_CLOSURE_POSITION | calls | 9 | 9 | 0 | 0 | 0 | yes |
| MOV_EXPR_PARSE | calls | 230 | 230 | 0 | 0 | 0 | yes |
| MOV_EXTENDS_CYCLE | nodes | 15 | 15 | 0 | 0 | 0 | yes |
| MOV_EXTENDS_NOT_A_NODE | nodes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_EXTENDS_REDEFINES | nodes | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_ANNOTATE | extraction | 21 | 21 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_CALL_NESTED | extraction | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_CONFIG | extraction | 27 | 27 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_CONTENT | extraction | 118 | 36 | 82 | 0 | 0 |  |
| MOV_EXTRACT_FIELD_DUPLICATE | extraction | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_NEEDS_ANNOTATION | extraction | 11 | 11 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_SHAPE_COMPUTED | extraction | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_SHAPE_NOT_DECLARED | extraction | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_TYPE_CONFLICT | extraction | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_EXTRACT_UNKNOWN_FIELD | extraction | 34 | 34 | 0 | 0 | 0 | yes |
| MOV_FILE_IN_TEXT | records | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_FOLD_NEEDS_ORDER | values | 165 | 165 | 0 | 0 | 0 | yes |
| MOV_FUNCTION_NAME_COLLISION | names | 13 | 13 | 0 | 0 | 0 | yes |
| MOV_FUNCTION_UNKNOWN | calls | 23 | 23 | 0 | 0 | 0 | yes |
| MOV_GRAPH_ENTRY_KIND | nodes | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_GRAPH_ENTRY_RECORD | nodes | 127 | 126 | 1 | 59 | 0 |  |
| MOV_GRAPH_FIELD_MISSING | nodes | 34 | 34 | 0 | 0 | 0 | yes |
| MOV_GRAPH_FIELD_TYPE | nodes | 25 | 25 | 0 | 0 | 0 | yes |
| MOV_GRAPH_FIELD_UNKNOWN | nodes | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_GRAPH_REFERENCE_SHAPE | nodes | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_GRAPH_SHAPE | nodes | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_GRAPH_SPREAD_NOT_MAP | nodes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_GRAPH_SPREAD_RECORD | nodes | 43 | 23 | 20 | 0 | 0 |  |
| MOV_GRAPH_SPREAD_UNTYPED | nodes | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_HANDLE_FIELD_RETIRED | records | 14 | 14 | 0 | 0 | 0 | yes |
| MOV_HANDLE_FILE_NOT_SENT | records | 3 | 3 | 0 | 0 | 0 | yes |
| MOV_HANDLE_READ_FOUND | records | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_HANDLE_UPDATED_IN_PLACE | writes | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_HEAD_NEEDS_A_NAME | flow | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_HEAD_NOT_A_POSITION | walks | 36 | 36 | 0 | 0 | 0 | yes |
| MOV_HOP_CONFIG_UNREAD | walks | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_HOP_FILTER_ENGINE | walks | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_HOP_FILTER_RESIDUAL | walks | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_HOP_FILTER_UNSUPPORTED | walks | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_HOP_ORDER_ENGINE | walks | 60 | 60 | 0 | 0 | 0 | yes |
| MOV_HOP_ORDER_UNSUPPORTED | walks | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_IF_WITHOUT_ELSE | flow | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_IMPORT_CYCLE | imports | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_IMPORT_DUPLICATE | names | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_INVALID | imports | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_UNRESOLVED | imports | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_IMPORT_FILE_UNSUPPORTED | imports | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_IMPORT_NOT_EXPORTED | imports | 30 | 30 | 0 | 0 | 0 | yes |
| MOV_IMPORT_UNKNOWN | names | 41 | 41 | 0 | 0 | 0 | yes |
| MOV_INLINE_BLOCK_RETIRED | closures | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_JSON_OPAQUE | values | 221 | 221 | 0 | 0 | 0 | yes |
| MOV_LANGUAGE_VERSION_UNSUPPORTED | versions | 9 | 9 | 0 | 0 | 0 | yes |
| MOV_LIMIT_NEEDS_ORDER | walks | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_LINKED_HOP_RETIRED | writes | 10 | 10 | 0 | 0 | 0 | yes |
| MOV_LINKED_NEEDS_TYPE | writes | 35 | 35 | 0 | 0 | 0 | yes |
| MOV_LINKED_TYPE_MISMATCH | writes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_LINKED_UNKNOWN_EDGE | writes | 61 | 61 | 0 | 0 | 0 | yes |
| MOV_LINK_MATCH_BODY_RETIRED | writes | 36 | 36 | 0 | 0 | 0 | yes |
| MOV_LINK_UNSUPPORTED_EDGE | writes | 19 | 19 | 0 | 0 | 0 | yes |
| MOV_LISTEN_ALIAS_DUPLICATE | listens | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_LISTEN_BAD_CONFIG | listens | 210 | 210 | 0 | 0 | 0 | yes |
| MOV_LISTEN_CANNOT_FIRE | listens | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_LISTEN_DUPLICATE | listens | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_LISTEN_FILE_LEVEL | listens | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_LISTEN_MISSING | listens | 23731 | 23731 | 0 | 0 | 0 | yes |
| MOV_LISTEN_NOT_INSTANCE | listens | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_LISTEN_PARAM_MISMATCH | listens | 220 | 220 | 0 | 0 | 0 | yes |
| MOV_LISTEN_SHAPE_MISMATCH | listens | 36 | 36 | 0 | 0 | 0 | yes |
| MOV_LIST_MIXED | values | 51 | 45 | 6 | 0 | 0 |  |
| MOV_LIST_SPREAD_NOT_A_LIST | values | 16 | 16 | 0 | 0 | 0 | yes |
| MOV_MAP_KEY_OVERWRITTEN | values | 13 | 13 | 0 | 0 | 0 | yes |
| MOV_MAP_SPREAD_NOT_KEYED | values | 77 | 77 | 0 | 0 | 0 | yes |
| MOV_MATCH_MISS_CONTINUES | writes | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_MATCH_NO_IDENTITY | writes | 19 | 19 | 0 | 0 | 0 | yes |
| MOV_MATCH_UNNAMED | writes | 39 | 39 | 0 | 0 | 0 | yes |
| MOV_MEMBERS_NOT_CLOSED | nodes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_META_HOP_RETIRED | walks | 20 | 20 | 0 | 0 | 0 | yes |
| MOV_META_UNKNOWN_KEY | walks | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_NAME_PROTO | names | 54 | 54 | 0 | 0 | 0 | yes |
| MOV_NAME_UNRESOLVED | names | 401 | 401 | 0 | 0 | 0 | yes |
| MOV_NARROWING | walks | 126 | 126 | 0 | 0 | 0 | yes |
| MOV_NESTED_CALL_SUSPENDS | calls | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_NODE_ARG_SHAPE | nodes | 117 | 117 | 0 | 0 | 0 | yes |
| MOV_NODE_EDGE_DEFERRED | nodes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_NODE_EDGE_UNDECLARED | nodes | 45 | 45 | 0 | 0 | 0 | yes |
| MOV_NODE_ENTRY_DUPLICATE | nodes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_NODE_ENTRY_NODE_VALUE | nodes | 24 | 24 | 0 | 0 | 0 | yes |
| MOV_NODE_ENTRY_TYPE | nodes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_NODE_LANDING_MISMATCH | nodes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_NODE_LINK_BODY | nodes | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_NODE_LINK_SHAPE | nodes | 48 | 48 | 0 | 0 | 0 | yes |
| MOV_OLD_EDGE_NOT_A_WRITE | walks | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_OPTION_INVALID | systems | 17 | 17 | 0 | 0 | 0 | yes |
| MOV_ORDER_KEY_IMPURE | values | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_ORDER_KEY_MULTI | values | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_PARALLEL_RETIRED | closures | 195 | 195 | 0 | 0 | 0 | yes |
| MOV_PARAM_NEEDS_TYPE | calls | 31 | 31 | 0 | 0 | 0 | yes |
| MOV_PARENT_READ_RETIRED | walks | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_ARGS_NAMED | calls | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_FED_BY_EXTRACTION | extraction | 17 | 17 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_OUTPUT_CHANGED | versions | 2 | 2 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_OUTPUT_UNDECLARED | calls | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_PLUGIN_ROW_UNDECLARED | calls | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_PRESENCE_TEST_CONSTANT | values | 173 | 173 | 0 | 0 | 0 | yes |
| MOV_PRESENCE_TEST_ON_TEXT | values | 86 | 86 | 0 | 0 | 0 | yes |
| MOV_READ_NOT_FILE | extraction | 15 | 15 | 0 | 0 | 0 | yes |
| MOV_REBOUND_NAME | names | 13 | 13 | 0 | 0 | 0 | yes |
| MOV_RECEIPT_RECORD_SLOT | records | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_RECORD_NOT_A_VALUE | records | 52 | 52 | 0 | 0 | 0 | yes |
| MOV_RECURSIVE_RETURN_TYPE | calls | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_REFRESH_UNSTABLE | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_RESERVED_NAME | names | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_RESOURCES_NOT_EXTRACTED | extraction | 51 | 51 | 0 | 0 | 0 | yes |
| MOV_RESOURCE_READ_RETIRED | extraction | 14 | 14 | 0 | 0 | 0 | yes |
| MOV_RESOURCE_WALK_UNREAD | extraction | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_RETURN_NOT_A_VALUE | calls | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_RETURN_OUTSIDE_BODY | calls | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_RETURN_PLANE_MISMATCH | calls | 7 | 7 | 0 | 0 | 0 | yes |
| MOV_RETURN_TYPE | calls | 34 | 33 | 1 | 0 | 0 |  |
| MOV_SHADOWED_NAME | names | 59 | 59 | 0 | 0 | 0 | yes |
| MOV_SHAPE_FIELD_PROTO | nodes | 22 | 22 | 0 | 0 | 0 | yes |
| MOV_SHAPE_HOP_RETIRED | walks | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_SORT_KEY_ON_SCALAR | values | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_SORT_KEY_ON_WALK | values | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_SORT_NEEDS_KEY | values | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_SORT_NOT_COLLECTION | values | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_STDLIB_ARG_INVALID | calls | 37 | 37 | 0 | 0 | 0 | yes |
| MOV_STDLIB_ARG_LAZY_EDGE | records | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_STDLIB_ARG_NOT_LITERAL | calls | 27 | 27 | 0 | 0 | 0 | yes |
| MOV_STDLIB_ARG_NOT_RECORD | records | 198 | 198 | 0 | 0 | 0 | yes |
| MOV_TARGET_WHERE_BIND | writes | 4 | 4 | 0 | 0 | 0 | yes |
| MOV_TARGET_WHERE_LOCAL | writes | 9 | 9 | 0 | 0 | 0 | yes |
| MOV_TARGET_WHERE_NOT_FINAL | writes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_THROUGH_ARG_MISSING | extraction | 23 | 23 | 0 | 0 | 0 | yes |
| MOV_THROUGH_BAD_ARG | extraction | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_THROUGH_FORWARD_REF | extraction | 11 | 11 | 0 | 0 | 0 | yes |
| MOV_THROUGH_NOT_PLUGIN | extraction | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_TRANSFORM_HOP_RETIRED | walks | 14 | 14 | 0 | 0 | 0 | yes |
| MOV_TRAVERSE_UNKNOWN_EDGE | walks | 182 | 182 | 0 | 0 | 0 | yes |
| MOV_UNDESCRIBED_POSITION | walks | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_CONJUNCT_NEEDS_WHERE | writes | 37 | 37 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_FUZZY_UNSUPPORTED | writes | 25 | 25 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_KEY_MAY_BE_BLANK | writes | 8 | 8 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_NATIVE_REDUNDANT | writes | 14 | 14 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_NOT_AUTHORABLE | writes | 17 | 17 | 0 | 0 | 0 | yes |
| MOV_UNIQUE_UNKNOWN_FIELD | writes | 49 | 49 | 0 | 0 | 0 | yes |
| MOV_UNKNOWN_POSITION | walks | 84 | 84 | 0 | 0 | 0 | yes |
| MOV_UNKNOWN_PROPERTY | walks | 464 | 464 | 0 | 0 | 0 | yes |
| MOV_UNKNOWN_TYPE_NAME | nodes | 37 | 37 | 0 | 0 | 0 | yes |
| MOV_UNREACHABLE_BRANCH | walks | 42 | 42 | 0 | 0 | 0 | yes |
| MOV_UNTIL_CADENCE_TOO_SHORT | flow | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_UNTIL_EDGE_WATCHABLE | flow | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_USE_BEFORE_BIND | names | 29 | 29 | 0 | 0 | 0 | yes |
| MOV_VALUE_UNLISTED | values | 30 | 30 | 0 | 0 | 0 | yes |
| MOV_WAIT_NOT_RESUMABLE | flow | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_WRITE_APPEND_NOT_MULTI | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_NOT_RECORD | writes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_NO_UPDATE | writes | 9 | 9 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_POSITION | writes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_RETIRED | writes | 26 | 26 | 0 | 0 | 0 | yes |
| MOV_WRITE_BIND_UNIQUE | writes | 5 | 5 | 0 | 0 | 0 | yes |
| MOV_WRITE_DISCRIMINANT_NOT_LITERAL | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_WRITE_EPHEMERAL_BOUND | writes | 12 | 12 | 0 | 0 | 0 | yes |
| MOV_WRITE_FIELD_TYPE | writes | 673 | 586 | 38 | 0 | 49 |  |
| MOV_WRITE_GENERIC_NOT_LITERAL | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_LINK_FIELD_NUDGE | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_MAY_BE_EMPTY | writes | 154 | 154 | 0 | 0 | 0 | yes |
| MOV_WRITE_MISSING_REQUIRED_EDGE | writes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_WRITE_MISSING_REQUIRED_FIELD | writes | 66 | 66 | 0 | 0 | 0 | yes |
| MOV_WRITE_ONLY_EDGE | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_ONLY_PROPERTY | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_POSITION_NOT_RECORD | writes | 31 | 10 | 21 | 0 | 0 |  |
| MOV_WRITE_POSITION_NO_UPDATE | writes | 14 | 14 | 0 | 174 | 0 |  |
| MOV_WRITE_POSITION_UNIQUE | writes | 18 | 18 | 0 | 0 | 0 | yes |
| MOV_WRITE_READ_ONLY_EDGE | writes | 53 | 53 | 0 | 0 | 0 | yes |
| MOV_WRITE_SHAPE_RETIRED | writes | 22 | 22 | 0 | 0 | 0 | yes |
| MOV_WRITE_SPREAD_SOURCE | writes | 125 | 125 | 0 | 0 | 0 | yes |
| MOV_WRITE_TARGET_NOT_GRAPH | writes | 25 | 25 | 0 | 0 | 0 | yes |
| MOV_WRITE_TUPLE_MISMATCH | writes | 6 | 6 | 0 | 0 | 0 | yes |
| MOV_WRITE_UNION_UNSATISFIED | writes | 30 | 30 | 0 | 0 | 0 | yes |
| MOV_WRITE_UNKNOWN_FIELD | writes | 156 | 137 | 19 | 0 | 0 |  |
