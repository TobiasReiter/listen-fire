# Porting the checker to Rust

The TypeScript checker (`packages/movement-lang/checker`) is the reference.
It stays the reference until this crate reports the same diagnostics for
every program in the parity harness (`PARITY.md`, `parity/run.sh`).

## What the TypeScript checker is

About 27,500 lines. Two files hold almost all of it:

- `check.ts` (15,200 lines): the `Checker` class. It walks statements,
  owns the scope chain and reports most statement-level diagnostics.
- `typing.ts` (7,400 lines): `ExpressionTyping`. It types one expression
  against a scope: property reads, edge walks, narrowing, operators,
  built-in calls.

The rest are helpers: `catalog.ts` (schema types, the catalog interface),
`scopes.ts` (the scope chain), `calls.ts` and `nested_calls.ts` (how a call
is read), `link.ts` (file imports), `effects.ts` and `call_cycles.ts`
(what a function may do, recursion), `event_address.ts`, `generics.ts`,
`standard_library.ts`, `meta.ts`, `conformance.ts`, `flow.ts`, `fixes.ts`
and `handbook_pointers.ts`.

### The passes

There is one walk, in source order. Within each statement list it runs
three steps:

1. **Hoist.** `type` declarations are bound first. Then movement and node
   declarations are bound, so they are visible across the whole list.
2. **Prescan.** Names that a later `=` or `import` in the same list will
   bind are marked pending. A read of one before its statement is reported
   as use before bind, not as an unknown name.
3. **Check** each statement. A statement that holds a body (a movement, a
   closure, a traversal block, an `if` arm) checks that body as its own list
   in a child scope.

Diagnostics come out in the order they are reported. Then the checker
prepends the language version diagnostic (and the link problems when files
are resolved). Then it appends a handbook pointer to the message of a fixed
set of codes.

Some steps re-walk a body only to learn its type, such as what a callee
returns. These walks report nothing (`typeOnly`).

### The scope model

- A scope is a map from name to symbol, plus a set of pending names, plus
  names that escaped a closed traversal block.
- Scope kinds: file, movement, traversal (a block body, the hop aliases of a
  walk) and branch (`if` arms, closures, combinator arms).
- Symbol kinds: adapter, credential, plugin, file import, binding, instance,
  param, movement, node declaration (`shape`), traversal alias, declared
  `type`.
- A name the author declares may not hide a name an enclosing scope binds
  (`MOV_SHADOWED_NAME`). A guard narrowing re-declares the same symbol with
  a sharper type and is not shadowing.
- Function names are compared without letter case from version 3
  (`MOV_FUNCTION_NAME_COLLISION`). Variable names keep their case.

### The type model

- **Field types** (`FieldType`, catalog.ts): the scalars (text, number,
  boolean, date, datetime, file, json, absent) and the composites list,
  tuple, dict, enum, may be absent, record and union. The Rust catalog
  (`movement_parser::catalog::types::FieldType`) already ports the schema
  half of this.
- **Positions** (`PositionTypeRef`, typing.ts): where a record handle
  stands in a system. A meta position (the system itself), a position
  (one record type of an instance), or a union of positions. Each carries
  its instance identity, and optionally the event it narrows, an address,
  the fields known present and what a parameter needs.
- **Planes** (`PlaneType`): a binding lives on the arrow plane (a position,
  reached with `-[…]->`) or the value plane (a field type, reached with
  `.`). A closure is a third kind of value: its parameters, its return
  shape and its effect row.
- **May hold a record**: a value whose type does not show that it can carry
  a record or a file (a conditional, a `COALESCE`) keeps a separate
  `mayHold` type. Walks use it; it is never a type a reader sees.

### Catalog inputs

The checker asks the catalog for an adapter's spec, an instance schema for a
construction, a credential's adapters, a plugin's spec, the models list and
the options for a construction argument. The engine already reads the same
answers from a catalog snapshot (`movement_parser::catalog`). The parity
corpus pins programs against snapshots, so a checker that reads a snapshot
is all that parity needs.

## Diagnostic families

251 codes. "Raise sites" counts the places in the TypeScript code that
report a code. "Corpus" counts how often the code appears in the harvested
checks corpus as it stood when the port was planned (`checks.json`, 5,899
programs under versions 1 to 3; re-harvested since to 19,375 programs under
versions 1 to 5, which PARITY.md measures).

The family is also the Rust module (`src/families/<family>.rs`).

| family | codes | raise sites | corpus diagnostics |
|---|---|---|---|
| names | 11 | 21 | 273 |
| imports | 5 | 5 | 33 |
| versions | 3 | 3 | 7 |
| systems | 8 | 16 | 74 |
| listens | 12 | 36 | 5407 |
| calls | 27 | 71 | 310 |
| closures | 15 | 25 | 171 |
| flow | 10 | 12 | 54 |
| values | 22 | 43 | 820 |
| walks | 25 | 47 | 546 |
| records | 12 | 17 | 36 |
| writes | 51 | 60 | 488 |
| nodes | 30 | 42 | 218 |
| extraction | 20 | 30 | 120 |

### names

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_CREDENTIAL_NOT_A_VALUE | check.ts:resolveName | 0 |
| MOV_DUPLICATE_DECL | check.ts:hoistDeclarations ×2, check.ts:checkClosure, check.ts:checkMovement ×2 | 12 |
| MOV_FUNCTION_NAME_COLLISION | check.ts:checkFunctionName ×2 | 5 |
| MOV_IMPORT_DUPLICATE | check.ts:checkImport | 9 |
| MOV_IMPORT_UNKNOWN | check.ts:checkImport | 15 |
| MOV_NAME_PROTO | check.ts:declareAuthored | 0 |
| MOV_NAME_UNRESOLVED | check.ts:reportUnimportedAdapterConstruction, check.ts:reportResolutionFailure ×5 | 182 |
| MOV_REBOUND_NAME | check.ts:checkAssign | 6 |
| MOV_RESERVED_NAME | check.ts:checkAssign | 3 |
| MOV_SHADOWED_NAME | check.ts:declareAuthored | 27 |
| MOV_USE_BEFORE_BIND | check.ts:reportResolutionFailure | 14 |

### imports

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_IMPORT_CYCLE | link.ts:linkImports | 3 |
| MOV_IMPORT_FILE_INVALID | link.ts:linkImports | 3 |
| MOV_IMPORT_FILE_UNRESOLVED | link.ts:linkImports | 3 |
| MOV_IMPORT_FILE_UNSUPPORTED | check.ts:checkImport | 9 |
| MOV_IMPORT_NOT_EXPORTED | link.ts:linkImports | 15 |

### versions

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_LANGUAGE_VERSION_DEPRECATED | language_version.ts:languageVersionDiagnostic | 0 |
| MOV_LANGUAGE_VERSION_UNSUPPORTED | language_version.ts:languageVersionDiagnostic | 5 |
| MOV_PLUGIN_OUTPUT_CHANGED | check.ts:reportPluginOutputChanged | 2 |

### systems

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_ADAPTER_NOT_CONSTRUCTED | check.ts:checkPathHead, check.ts:declaredEdgeAddress, check.ts:checkMovement, check.ts:checkListen ×2 | 21 |
| MOV_AI_TIER_LEGACY | typing.ts:aiTierDiagnostics | 6 |
| MOV_CONSTRUCT_BAD_ARG | check.ts:checkConstruction ×2 | 9 |
| MOV_CONSTRUCT_MISSING_CRED | check.ts:checkConstruction | 6 |
| MOV_CONSTRUCT_NOT_ADAPTER | check.ts:checkConstruction | 10 |
| MOV_CONSTRUCT_UNKNOWN_OPTION | check.ts:checkConstruction | 3 |
| MOV_CRED_WRONG_ADAPTER | check.ts:checkCredentialArg ×3 | 11 |
| MOV_OPTION_INVALID | typing.ts:typeOptionsMap ×2 | 8 |

### listens

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_CALLBACK_BAD_CONFIG | check.ts:checkCallbackConfig ×4 | 12 |
| MOV_CALLBACK_NOT_MOVEMENT | check.ts:checkCallbackNamed | 7 |
| MOV_CALLBACK_PARAM_NOT_VALUE | check.ts:checkCallbackParamType ×2 | 10 |
| MOV_LISTEN_ALIAS_DUPLICATE | check.ts:checkListen | 3 |
| MOV_LISTEN_BAD_CONFIG | check.ts:checkListen ×13 | 102 |
| MOV_LISTEN_CANNOT_FIRE | check.ts:checkListen | 3 |
| MOV_LISTEN_DUPLICATE | check.ts:checkListen | 6 |
| MOV_LISTEN_FILE_LEVEL | check.ts:checkListen | 3 |
| MOV_LISTEN_MISSING | check.ts:reportMissingListens | 5131 |
| MOV_LISTEN_NOT_INSTANCE | check.ts:checkListen | 6 |
| MOV_LISTEN_PARAM_MISMATCH | check.ts:checkListen ×5 | 106 |
| MOV_LISTEN_SHAPE_MISMATCH | check.ts:checkListenShapeConformance ×2, check.ts:conformShapeNode ×3 | 18 |

### calls

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_BUILTIN_ARGS | check.ts:reportCallRefusal, check.ts:checkCallInExpression ×2 | 11 |
| MOV_BUILTIN_ARG_TYPE | typing.ts:checkBuiltinArgs | 10 |
| MOV_BUILTIN_NOT_RUN | check.ts:checkCallInExpression | 3 |
| MOV_BUILTIN_UNUSED | check.ts:reportCallRefusal | 1 |
| MOV_CALL_ARG_DUPLICATE | check.ts:checkArgumentBindings | 6 |
| MOV_CALL_ARG_MISSING | check.ts:checkArgumentBindings | 16 |
| MOV_CALL_ARG_TYPE | check.ts:checkCallArg ×3, check.ts:refuseValueForPosition, check.ts:checkValueArgFit ×2, check.ts:checkRecordArgFit ×6, check.ts:checkCallArgFit ×2, check.ts:checkPluginArgValue ×5, check.ts:refusePluginRecordInPlace | 35 |
| MOV_CALL_ARG_UNKNOWN | check.ts:checkArgumentBindings | 13 |
| MOV_CALL_ARITY | check.ts:checkCall ×2 | 11 |
| MOV_CALL_CLOSURE_RETURNS | check.ts:warnLaterClosureReturns | 0 |
| MOV_CALL_NESTED | check.ts:checkExpressionTree, check.ts:checkCallInExpression ×2, nested_calls.ts:(top) | 6 |
| MOV_CALL_NOT_MOVEMENT | check.ts:checkCallInExpression ×2, check.ts:checkCall ×2, check.ts:checkListen | 9 |
| MOV_CALL_RETURNS_NOTHING | check.ts:reportCallReturnsNothing | 13 |
| MOV_EXPR_CLOSURE_POSITION | (declared, never raised) | 0 |
| MOV_EXPR_PARSE | check.ts:hoistNestedCalls, check.ts:checkCollectionConfig, check.ts:checkIdentity, check.ts:checkPathHead, check.ts:checkExtractCallConfig, check.ts:reportSlotError | 103 |
| MOV_FUNCTION_UNKNOWN | check.ts:reportCalleeUnresolved, check.ts:checkDottedCall, check.ts:checkCallInExpression | 7 |
| MOV_NESTED_CALL_SUSPENDS | check.ts:hoistNestedCalls | 3 |
| MOV_PARAM_NEEDS_TYPE | check.ts:reportParamNeedsType | 9 |
| MOV_PLUGIN_ARGS_NAMED | check.ts:checkPluginApplication | 1 |
| MOV_PLUGIN_OUTPUT_UNDECLARED | check.ts:refusePlainPluginCall | 3 |
| MOV_PLUGIN_ROW_UNDECLARED | check.ts:refusePlainPluginCall | 3 |
| MOV_RECURSIVE_RETURN_TYPE | check.ts:checkClosure ×2, check.ts:checkMovement | 4 |
| MOV_RETURN_NOT_A_VALUE | check.ts:checkRValue | 3 |
| MOV_RETURN_OUTSIDE_BODY | check.ts:checkReturn ×2 | 3 |
| MOV_RETURN_PLANE_MISMATCH | check.ts:closeReturns | 3 |
| MOV_RETURN_TYPE | check.ts:checkDeclaredReturn, check.ts:checkReturnFit ×6 | 6 |
| MOV_STDLIB_ARG_INVALID | typing.ts:checkStdlibLiteralArgs | 16 |
| MOV_STDLIB_ARG_NOT_LITERAL | typing.ts:checkStdlibLiteralArgs | 12 |
| MOV_TYPE_TOO_LARGE | check.ts:withinTypeLimit (checkAssign, checkClosure, checkMovement) | 0 |

### closures

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_BLOCK_READ_BACK_RETIRED | check.ts:reportBlockReadBack | 9 |
| MOV_BLOCK_RETURNS_NOTHING | check.ts:checkRValue | 114 |
| MOV_CLOSURE_NOT_DATA | check.ts:valueMemberType ×2, check.ts:checkCollectionOp ×2, check.ts:reportFieldValueType, check.ts:checkCombinator, check.ts:reportSlotError, typing.ts:refuseClosureAsData | 0 |
| MOV_COLLECTION_OP_ARITY | check.ts:reportArmArity | 6 |
| MOV_COLLECTION_OP_CONFIG | check.ts:checkCollectionConfig, check.ts:reportCombinatorForm | 7 |
| MOV_COLLECTION_OP_NOT_A_COLLECTION | check.ts:reportNotACollection | 7 |
| MOV_COLLECTION_OP_RETURNS_NOTHING | check.ts:requireCollectionReturn | 8 |
| MOV_COLLECTION_OP_SUSPENDS | check.ts:absorbCollectionRow | 2 |
| MOV_COMBINATOR_ARMS_ARE_ARGUMENTS | check.ts:reportCombinatorForm | 0 |
| MOV_COMBINATOR_ARM_NOT_FUNCTION | check.ts:checkArm | 3 |
| MOV_COMBINATOR_ARM_TAKES_NOTHING | check.ts:reportArmArity | 3 |
| MOV_COMBINATOR_NEEDS_AWAIT | check.ts:reportCombinatorNeedsAwait | 6 |
| MOV_COMBINATOR_NO_AWAIT | check.ts:reportCombinatorForm | 0 |
| MOV_INLINE_BLOCK_RETIRED | check.ts:reportInlineBlockRetired | 6 |
| MOV_PARALLEL_RETIRED | check.ts:reportParallelRetired ×3 | 0 |

### flow

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_AWAIT_BAD_DURATION | check.ts:checkAwait, check.ts:checkUntil | 3 |
| MOV_AWAIT_BARE_WALK | check.ts:checkAwait | 9 |
| MOV_AWAIT_IMPURE_CONDITION | check.ts:checkUntilCondition, check.ts:reportImpureCondition | 9 |
| MOV_AWAIT_NEEDS_CADENCE | check.ts:checkAwait | 6 |
| MOV_AWAIT_NOT_AWAITABLE | check.ts:checkAwait | 9 |
| MOV_HEAD_NEEDS_A_NAME | check.ts:checkAwait | 3 |
| MOV_IF_WITHOUT_ELSE | check.ts:checkExpressionTree | 3 |
| MOV_UNTIL_CADENCE_TOO_SHORT | check.ts:checkUntil | 3 |
| MOV_UNTIL_EDGE_WATCHABLE | check.ts:checkUntil | 3 |
| MOV_WAIT_NOT_RESUMABLE | check.ts:refuseUnresumableWait | 6 |

### values

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_ABSENT_REQUIRED | check.ts:DiagnosticCodes, check.ts:checkWrite, check.ts:reportAbsentWriteField ×3, check.ts:checkLinkedPath, check.ts:reportAbsentEdgeEnd, check.ts:checkGraphField, typing.ts:spreadParts, typing.ts:reportAbsentInComparison | 363 |
| MOV_ARITH_NON_NUMERIC | typing.ts:checkArithmeticOperands, typing.ts:checkNegateOperand | 55 |
| MOV_COMPARE_TYPE_MISMATCH | typing.ts:checkNullComparison, typing.ts:checkWithinDuration, typing.ts:reportCompareMismatch | 45 |
| MOV_DICT_KEY_NOT_TEXT | typing.ts:requireDictKey | 9 |
| MOV_DICT_UNKNOWN_KEY | typing.ts:reportUnknownDictKey | 16 |
| MOV_ENUM_EMPTY_DOMAIN | typing.ts:checkEnumDomain | 9 |
| MOV_ENUM_UNKNOWN_VALUE | catalog.ts:surfaceNotEnumerated, typing.ts:aiTierDiagnostics, typing.ts:checkEnumLiteral, typing.ts:requireTransparent | 87 |
| MOV_FOLD_NEEDS_ORDER | check.ts:checkCollectionOp, typing.ts:checkFoldOrder | 80 |
| MOV_JSON_OPAQUE | typing.ts:checkJsonOpaque | 41 |
| MOV_LIST_MIXED | catalog.ts:pluginOutputUnder, check.ts:readHeldValue, typing.ts:widen | 13 |
| MOV_LIST_SPREAD_NOT_A_LIST | typing.ts:spreadParts ×2 | 4 |
| MOV_MAP_KEY_OVERWRITTEN | check.ts:checkGraphBody, typing.ts:objectLiteralType | 7 |
| MOV_MAP_SPREAD_NOT_KEYED | typing.ts:spreadKeys | 3 |
| MOV_ORDER_KEY_IMPURE | typing.ts:checkOrderingKey | 3 |
| MOV_ORDER_KEY_MULTI | typing.ts:checkOrderingKey | 3 |
| MOV_PRESENCE_TEST_CONSTANT | typing.ts:reportConstantPresenceTest, typing.ts:checkNullComparison | 14 |
| MOV_PRESENCE_TEST_ON_TEXT | typing.ts:refuseTextPresenceTest | 35 |
| MOV_SORT_KEY_ON_SCALAR | typing.ts:inferSort | 3 |
| MOV_SORT_KEY_ON_WALK | typing.ts:inferSort | 6 |
| MOV_SORT_NEEDS_KEY | typing.ts:inferSort | 6 |
| MOV_SORT_NOT_COLLECTION | typing.ts:inferSort | 3 |
| MOV_VALUE_UNLISTED | typing.ts:checkEnumLiteral | 15 |

### walks

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_AMBIGUOUS_PROPERTY | typing.ts:reportAmbiguousProperty | 3 |
| MOV_ARTIFICIAL_EDGE_UNKNOWN | typing.ts:stepArtificialEdge | 0 |
| MOV_AWAIT_IMPURE_WHERE | typing.ts:stepEdge ×2 | 0 |
| MOV_AWAIT_REQUIRED | typing.ts:stepEdge | 0 |
| MOV_HEAD_NOT_A_POSITION | check.ts:checkPathHead | 18 |
| MOV_HOP_CONFIG_UNREAD | check.ts:checkWalkKeepsWhatIsWritten | 3 |
| MOV_HOP_FILTER_ENGINE | typing.ts:gateHopCapability | 6 |
| MOV_HOP_FILTER_RESIDUAL | typing.ts:gateHopCapability | 9 |
| MOV_HOP_FILTER_UNSUPPORTED | typing.ts:gateHopCapability ×3 | 12 |
| MOV_HOP_LIMIT_UNSUPPORTED | typing.ts:gateHopCapability | 0 |
| MOV_HOP_ORDER_ENGINE | typing.ts:gateHopCapability ×2 | 27 |
| MOV_HOP_ORDER_UNSUPPORTED | typing.ts:gateHopCapability ×2 | 12 |
| MOV_LIMIT_NEEDS_ORDER | typing.ts:checkHopLimitOrder | 6 |
| MOV_META_HOP_RETIRED | check.ts:checkWalkKeepsWhatIsWritten, check.ts:reportMetaHopsInTypeRef | 0 |
| MOV_META_UNKNOWN_KEY | typing.ts:checkMetaKey | 12 |
| MOV_NARROWING | typing.ts:stepEdge, typing.ts:readProperty | 63 |
| MOV_OLD_EDGE_NOT_A_WRITE | typing.ts:stepArtificialEdge | 0 |
| MOV_PARENT_READ_RETIRED | check.ts:checkSpecialRecordRead | 4 |
| MOV_SHAPE_HOP_RETIRED | check.ts:positionFromTypeRefStrict, check.ts:checkDeclaredNodeTest | 6 |
| MOV_TRANSFORM_HOP_RETIRED | check.ts:checkWalkKeepsWhatIsWritten | 4 |
| MOV_TRAVERSE_UNKNOWN_EDGE | typing.ts:stepEdge ×6 | 81 |
| MOV_UNDESCRIBED_POSITION | catalog.ts:describeMember ×2, check.ts:positionFromAddress, typing.ts:reportUndescribed | 6 |
| MOV_UNKNOWN_POSITION | check.ts:reportUnknownPosition | 42 |
| MOV_UNKNOWN_PROPERTY | typing.ts:readProperty ×6 | 211 |
| MOV_UNREACHABLE_BRANCH | typing.ts:stepEdge, typing.ts:readProperty | 21 |

### records

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_AT_RECORD_KEY | typing.ts:typeExactAt | 0 |
| MOV_CALL_ARG_MAYBE_RECORD | check.ts:refuseMaybeRecordForPosition | 0 |
| MOV_CALL_ARG_OPAQUE_RECORD | check.ts:checkMembersFieldsInHand, check.ts:checkArgFieldsInHand | 0 |
| MOV_FILE_IN_TEXT | typing.ts:refuseFileInText | 0 |
| MOV_HANDLE_FIELD_RETIRED | typing.ts:readProperty | 0 |
| MOV_HANDLE_FILE_NOT_SENT | typing.ts:refuseUnsentFile | 0 |
| MOV_HANDLE_READ_FOUND | typing.ts:reportHandleReadFound | 0 |
| MOV_INTERNAL_UNTYPED_BINDING | check.ts:recordOfName | 0 |
| MOV_RECEIPT_RECORD_SLOT | check.ts:returnPlane, typing.ts:reportReceiptRecordSlot | 0 |
| MOV_RECORD_NOT_A_VALUE | typing.ts:checkRecordAsValue | 18 |
| MOV_STDLIB_ARG_LAZY_EDGE | typing.ts:checkStdlibWholeValueArg | 2 |
| MOV_STDLIB_ARG_NOT_RECORD | typing.ts:checkStdlibRecordArg ×2, typing.ts:checkStdlibWholeValueArg ×2 | 16 |

### writes

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_DELETE_NOT_DECLARED | check.ts:checkDeleteDeclared | 0 |
| MOV_DELETE_NOT_RECORD | check.ts:checkDeleteDeclared | 0 |
| MOV_HANDLE_UPDATED_IN_PLACE | check.ts:checkWrite | 0 |
| MOV_LINKED_HOP_RETIRED | check.ts:checkWalkKeepsWhatIsWritten | 4 |
| MOV_LINKED_NEEDS_TYPE | check.ts:checkLinkedPath | 11 |
| MOV_LINKED_TARGET_NOT_WRITABLE | (declared, never raised) | 0 |
| MOV_LINKED_TYPE_MISMATCH | check.ts:checkLinkedPath ×2 | 9 |
| MOV_LINKED_UNKNOWN_EDGE | check.ts:checkLinkedPath | 29 |
| MOV_LINK_MATCH_BODY_RETIRED | check.ts:reportLinkBodyRetired | 0 |
| MOV_LINK_UNSUPPORTED_EDGE | check.ts:reportUnlinkableEdge | 9 |
| MOV_MATCH_MISS_CONTINUES | check.ts:checkMatch | 0 |
| MOV_MATCH_NO_IDENTITY | check.ts:checkMatch | 6 |
| MOV_MATCH_UNNAMED | check.ts:checkStatement | 0 |
| MOV_REFRESH_UNSTABLE | check.ts:checkRefresh ×3 | 6 |
| MOV_TARGET_WHERE_BIND | check.ts:checkLinkedPath | 2 |
| MOV_TARGET_WHERE_LOCAL | check.ts:checkLinkedPath | 2 |
| MOV_TARGET_WHERE_NOT_FINAL | check.ts:checkLinkedPath | 2 |
| MOV_UNIQUE_CONJUNCT_NEEDS_WHERE | check.ts:checkIdentity, check.ts:checkIdentityNarrowing | 12 |
| MOV_UNIQUE_FUZZY_UNSUPPORTED | check.ts:checkFuzzyComponent ×2 | 9 |
| MOV_UNIQUE_KEY_MAY_BE_BLANK | check.ts:reportBlankableIdentityKey | 8 |
| MOV_UNIQUE_NATIVE_REDUNDANT | check.ts:checkNativeUniqueness | 6 |
| MOV_UNIQUE_NOT_AUTHORABLE | check.ts:checkIdentity | 7 |
| MOV_UNIQUE_UNKNOWN_FIELD | check.ts:checkIdentity | 23 |
| MOV_WRITE_APPEND_NOT_MULTI | check.ts:checkWrite | 6 |
| MOV_WRITE_BIND_NOT_RECORD | check.ts:checkBindClause ×2 | 3 |
| MOV_WRITE_BIND_NO_UPDATE | check.ts:checkBindClause | 5 |
| MOV_WRITE_BIND_POSITION | check.ts:checkBindClause | 3 |
| MOV_WRITE_BIND_RETIRED | check.ts:checkBindClause | 0 |
| MOV_WRITE_BIND_UNIQUE | check.ts:checkBindClause | 3 |
| MOV_WRITE_DISCRIMINANT_NOT_LITERAL | check.ts:selectWriteVariant | 6 |
| MOV_WRITE_EPHEMERAL_BOUND | check.ts:checkLinkedPath | 6 |
| MOV_WRITE_FIELD_TYPE | check.ts:reportFieldValueType ×4 | 52 |
| MOV_WRITE_GENERIC_NOT_LITERAL | check.ts:applyGenericLandings | 3 |
| MOV_WRITE_GENERIC_UNTYPED | check.ts:applyGenericLandings | 0 |
| MOV_WRITE_LINK_FIELD_NUDGE | check.ts:checkWrite | 3 |
| MOV_WRITE_MAY_BE_EMPTY | check.ts:checkWrite | 77 |
| MOV_WRITE_MISSING_REQUIRED_EDGE | check.ts:checkRequiredEdges | 9 |
| MOV_WRITE_MISSING_REQUIRED_FIELD | check.ts:checkRequiredFields | 32 |
| MOV_WRITE_ONLY_EDGE | typing.ts:reportWriteOnlyEdge | 3 |
| MOV_WRITE_ONLY_PROPERTY | typing.ts:reportWriteOnlyProperty | 3 |
| MOV_WRITE_POSITION_NOT_RECORD | check.ts:checkPositionWriteTarget ×2 | 3 |
| MOV_WRITE_POSITION_NO_UPDATE | check.ts:checkPositionWriteTarget | 3 |
| MOV_WRITE_POSITION_UNIQUE | check.ts:checkWrite | 3 |
| MOV_WRITE_READ_ONLY_EDGE | check.ts:checkLinkedPath | 26 |
| MOV_WRITE_SHAPE_RETIRED | check.ts:refuseShapeWrite | 6 |
| MOV_WRITE_SPREAD_SOURCE | check.ts:spreadFields | 2 |
| MOV_WRITE_TARGET_NOT_GRAPH | check.ts:checkLinkedPath | 12 |
| MOV_WRITE_TUPLE_MISMATCH | check.ts:checkTupleWriteTarget | 3 |
| MOV_WRITE_UNION_UNSATISFIED | check.ts:checkWriteUnion | 15 |
| MOV_WRITE_UNKNOWN_FIELD | check.ts:checkWrite, check.ts:checkMatch | 56 |
| MOV_WRITE_UNKNOWN_ROOT | (declared, never raised) | 0 |

### nodes

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_BORROW_MALFORMED | check.ts:resolveNamedType | 0 |
| MOV_BORROW_UNKNOWN_FIELD | check.ts:resolveNamedType | 9 |
| MOV_BORROW_UNKNOWN_GRAPH | check.ts:resolveNamedType ×2 | 9 |
| MOV_BORROW_UNKNOWN_ROOT | check.ts:resolveNamedType | 6 |
| MOV_EXTENDS_CYCLE | check.ts:settledBase | 6 |
| MOV_EXTENDS_NOT_A_NODE | check.ts:settledBase | 2 |
| MOV_EXTENDS_REDEFINES | check.ts:refuseRedefinitions ×2 | 4 |
| MOV_GRAPH_COPY_SHAPE | check.ts:checkGraphRecordSpread | 0 |
| MOV_GRAPH_ENTRY_KIND | check.ts:reportGraphUnknown ×2, check.ts:checkSpreadKeys | 4 |
| MOV_GRAPH_ENTRY_RECORD | check.ts:refuseRecordInGraphEntry ×2 | 0 |
| MOV_GRAPH_FIELD_MISSING | check.ts:reportMissingGraphFields | 9 |
| MOV_GRAPH_FIELD_TYPE | check.ts:checkGraphField | 6 |
| MOV_GRAPH_FIELD_UNKNOWN | check.ts:reportGraphUnknown | 2 |
| MOV_GRAPH_REFERENCE_SHAPE | check.ts:checkGraphReferenceFits | 4 |
| MOV_GRAPH_SHAPE | check.ts:checkGraphLiteral | 1 |
| MOV_GRAPH_SPREAD_NOT_MAP | check.ts:checkGraphSpread | 2 |
| MOV_GRAPH_SPREAD_RECORD | check.ts:refuseRecordInGraphSpread | 0 |
| MOV_GRAPH_SPREAD_UNTYPED | check.ts:checkGraphSpread, check.ts:checkGraphRecordSpread, check.ts:checkSpreadKeys | 1 |
| MOV_MEMBERS_NOT_CLOSED | check.ts:checkMembers ×2 | 6 |
| MOV_NODE_ARG_SHAPE | check.ts:checkCallArgFit | 57 |
| MOV_NODE_EDGE_DEFERRED | check.ts:localWriteTarget, check.ts:checkLocalLink | 6 |
| MOV_NODE_EDGE_UNDECLARED | check.ts:reportUndeclaredLocalEdge | 18 |
| MOV_NODE_ENTRY_DUPLICATE | check.ts:noteEntryName | 3 |
| MOV_NODE_ENTRY_NODE_VALUE | check.ts:nodeValueEntryType ×2 | 12 |
| MOV_NODE_ENTRY_TYPE | check.ts:declaredEdgeLanding | 6 |
| MOV_NODE_LANDING_MISMATCH | check.ts:mergeLandings | 3 |
| MOV_NODE_LINK_BODY | check.ts:checkLink | 2 |
| MOV_NODE_LINK_SHAPE | check.ts:checkLocalLink ×2 | 24 |
| MOV_SHAPE_FIELD_PROTO | check.ts:checkNoPrototypeName | 0 |
| MOV_UNKNOWN_TYPE_NAME | check.ts:valueMemberType, check.ts:resolveNamedType | 16 |

### extraction

| code | raised at (file:function × sites) | corpus |
|---|---|---|
| MOV_CHUNKS_NOT_TEXT | typing.ts:typeChunksCall | 3 |
| MOV_EXTRACT_ANNOTATE | typing.ts:suggestAnnotation | 10 |
| MOV_EXTRACT_CALL_NESTED | typing.ts:typeExactAt | 2 |
| MOV_EXTRACT_CONFIG | check.ts:checkExtractCallConfig | 7 |
| MOV_EXTRACT_CONTENT | check.ts:checkExtractInput ×2, check.ts:checkExtractCallContent ×2 | 9 |
| MOV_EXTRACT_FIELD_DUPLICATE | check.ts:checkExtractStages, check.ts:checkFieldChildNamesApart | 6 |
| MOV_EXTRACT_NEEDS_ANNOTATION | typing.ts:readExtractField | 5 |
| MOV_EXTRACT_SHAPE_COMPUTED | check.ts:resolveExtractCallShape ×2 | 3 |
| MOV_EXTRACT_SHAPE_NOT_DECLARED | check.ts:resolveExtractShape | 2 |
| MOV_EXTRACT_TYPE_CONFLICT | typing.ts:readExtractField | 9 |
| MOV_EXTRACT_UNKNOWN_FIELD | typing.ts:readExtractField | 16 |
| MOV_PLUGIN_FED_BY_EXTRACTION | check.ts:refusePlainPluginCall ×2 | 6 |
| MOV_READ_NOT_FILE | typing.ts:typeReadCall | 6 |
| MOV_RESOURCES_NOT_EXTRACTED | check.ts:checkWalkKeepsWhatIsWritten, check.ts:checkResourcesOfExtraction ×2 | 0 |
| MOV_RESOURCE_READ_RETIRED | check.ts:checkSpecialRecordRead ×2 | 7 |
| MOV_RESOURCE_WALK_UNREAD | check.ts:checkWalkKeepsWhatIsWritten ×2 | 3 |
| MOV_THROUGH_ARG_MISSING | check.ts:reportPluginMissingArgs | 9 |
| MOV_THROUGH_BAD_ARG | check.ts:reportPluginBadArg | 9 |
| MOV_THROUGH_FORWARD_REF | check.ts:resolveNameWithFields | 5 |
| MOV_THROUGH_NOT_PLUGIN | check.ts:checkPluginCall | 3 |

## Port order and the parallel split

The core comes first and is done by one agent, because every family
leans on it:

1. **Core** (this skeleton): the statement walk with its scopes, slot
   reading (parse, lower, cache), the diagnostic shape, the version
   diagnostic, the handbook pointers.
2. **Names** (first family, done here). It decides which slots are read at
   all, so every other family inherits its walk.
3. **Type core**: `FieldType` operations (absent, unions, lists, tuples),
   positions and instance identity, and `infer` for an expression without
   walks. One agent. Every family except names, imports and versions needs
   it.

After the type core, these can run in parallel on disjoint modules:

| agent | modules | needs |
|---|---|---|
| A | `listens`, `systems`, `imports` | core |
| B | `values` | type core |
| C | `walks`, `records` | type core |
| D | `writes` | type core, walks |
| E | `nodes` | type core |
| F | `calls`, `closures`, `flow` | type core |
| G | `extraction` | type core, calls |
| H | `versions` (upgrade warnings) | each family's own construct |

- Agent A can start now: the listen and construction rules read the catalog
  and the scope, not expression types. `MOV_LISTEN_MISSING` alone is 5,131
  of the corpus's diagnostics, so A moves the record-level parity most.
- D and G start after C has the walk.
- Each agent owns its module and its rows in `PARITY.md`. The walk
  (`src/checker.rs`) calls each family through one function per construct,
  so two agents never edit the same function.
