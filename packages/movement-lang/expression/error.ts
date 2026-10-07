/** An expression the movement language refuses — a syntax error, or a tree
 *  the lowering to the shared `Expression` has no reading for. Every consumer
 *  (checker, story, engine) catches this one class. */
export class BridgeError extends Error {
  /** Character offset into the expression text, when the refusal has one. */
  pos?: number;
  /** A specific diagnostic code the checker should report instead of the
   *  generic MOV_EXPR_PARSE — set by a targeted refusal (e.g. a closure
   *  literal) that wants its own code, not a bare parse failure's. */
  code?: string;

  constructor(message: string, pos?: number, code?: string) {
    super(message);
    this.name = 'BridgeError';
    if (pos !== undefined) this.pos = pos;
    if (code !== undefined) this.code = code;
  }
}

/** The expression grammar's refusal: where in the text, and why. Built by
 *  the parser's WASM wrapper (parser/rust_parser.ts); the expression entry
 *  point (parser/expression/parse_expression.ts) re-exports it. */
export class ExpressionSyntaxError extends BridgeError {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(message, offset);
    this.name = 'ExpressionSyntaxError';
  }
}
