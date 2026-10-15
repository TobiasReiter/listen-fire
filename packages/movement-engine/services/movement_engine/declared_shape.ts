// A node declaration as the whole tree it stands for — every `extends`
// folded in, each declaration's field types resolved where it was written —
// with its schema. The checker builds the same fold (`inheritSchema`), so a
// declaration is compared at run time against the structure it was checked
// against. The TypeScript engine (run.ts `resolvedShape`) and the Rust
// engine's shim (rust_host.ts `check.compatible`) both read it here.

import {
  inheritDeclaration,
  inheritSchema,
  shapeToSchema,
  type InstanceSchema,
  type SchemaFieldType,
  type ShapeDeclaration,
} from 'movement-lang';

/** One declaration of an `extends` chain, with the `type`s of its file. */
export interface ChainLink {
  declaration: ShapeDeclaration;
  types: (name: string) => SchemaFieldType | undefined;
}

/** The fold of a chain written declaration first, its bases after it. */
export function foldedShape(chain: readonly ChainLink[]): { declaration: ShapeDeclaration; schema: InstanceSchema } {
  let resolved: { declaration: ShapeDeclaration; schema: InstanceSchema } | undefined;
  for (const link of [...chain].reverse()) {
    const own = shapeToSchema(link.declaration, link.types);
    resolved =
      resolved === undefined
        ? { declaration: link.declaration, schema: own }
        : {
            declaration: inheritDeclaration(link.declaration, resolved.declaration),
            schema: inheritSchema(own, link.declaration.name, { name: resolved.declaration.name, schema: resolved.schema }),
          };
  }
  if (resolved === undefined) throw new Error('foldedShape: an extends chain holds at least its own declaration');
  return resolved;
}
