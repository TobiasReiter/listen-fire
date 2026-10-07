//! One expression grammar for the movement language — a precedence-climbing
//! parser that builds the tree in `tree`. Ported read for read from the
//! TypeScript grammar it replaced; its every message and offset is pinned
//! (movement-lang parser/expression/__test__/trees_regression.unit.test.ts).
//!
//! Precedence and associativity, loosest first:
//!
//!   where    = or ('WHERE' or)?                — a filter, inside a call's parens
//!   or       = and ('OR' and)*
//!   and      = not ('AND' not)*
//!   not      = ('NOT' | '!') not | compare
//!   compare  = add (cmp add | 'CONTAINS' add | 'IN' add | 'EXISTS'
//!                   | 'WITHIN' duration | 'IS' type)?          — never chains
//!   add      = mul (('+' | '-') mul)*
//!   mul      = unary (('*' | '/' | '%') unary)*
//!   unary    = '-' unary | postfix
//!   postfix  = primary ('.' name | '(' args ')' | hop+ | '[' where ']')*
//!   primary  = '(' where ')' | closure | IF | literal | string | name | '@…'
//!            | hop+ | list | map | '<' type '>' | node | graph | declaration
//!
//! Nothing here knows what a name means: `COUNT(x)` and `EXISTS(p)` are calls.

use crate::lexer::{
    MAX_DEPTH, PResult, Previous, QuoteChar, Scanner, Segment, SyntaxError, TOO_DEEP, Tok, Token, fail,
    unrecognised_character_message,
};
use crate::scan::call_style_if_message;
use crate::tree::{
    Arrow, CHAIN_TOO_LONG, At, BinaryOp, CallArg, ClosureBody, DeclarationMember, DeclaredEdge, Direction, Duration, EntryValue, Hop,
    JsNumber, ListElement, LiteralEntry, LiteralValue, MExpr, MapKey, MapLiteral, MapMember, Name, NodeDeclaration,
    OrderBy, Param, Quote, RecordMember, SortDirection, Spread, StringKey, StringPart, StringQuoted, TypeExpr, UnaryOp,
};
use crate::util::utf16::{
    Utf16, is_ascii_digit, is_ident_char, is_ident_start, is_js_space, opt_is, space_run, starts_with_ci, to_string,
    trim, trim_end, trim_start,
};

/// Parses one expression text. Offsets in the tree and the error are UTF-16
/// indexes into `text`. A chain past `MAX_CHAIN` is refused once the tree is
/// built: the loops that read chains build them without recursing, and the
/// tree's drop does not recurse either.
pub fn parse_expression(text: &str) -> Result<MExpr, SyntaxError> {
    let src = Utf16::new(text);
    let tree = ExpressionParser::new(&src, 0, src.len(), 0).parse_whole()?;
    match tree.chain_overrun() {
        Some(pos) => fail(CHAIN_TOO_LONG, pos),
        None => Ok(tree),
    }
}

/// Which literal body an entry list belongs to: the value grammar differs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Body {
    Node,
    Graph,
}

impl Body {
    fn what(self) -> &'static str {
        match self {
            Body::Node => "the node literal",
            Body::Graph => "the graph literal",
        }
    }
}

struct ExpressionParser<'a> {
    sc: Scanner<'a>,
    pos: usize,
    previous: Previous,
    /// Inside a node or graph literal's entry, a newline at the entry's own
    /// bracket level ends the value — the statement layer's rule for entries.
    stop_at_newline: bool,
    last_end: usize,
    cache: Option<(usize, Previous, Token)>,
    depth: usize,
}

fn unit(c: char) -> u16 {
    c as u16
}

impl<'a> ExpressionParser<'a> {
    fn new(src: &'a Utf16, start: usize, limit: usize, depth: usize) -> Self {
        Self {
            sc: Scanner { src, limit },
            pos: start,
            previous: Previous::Start,
            stop_at_newline: false,
            last_end: start,
            cache: None,
            depth,
        }
    }

    fn parse_whole(&mut self) -> PResult<MExpr> {
        let expr = self.parse_where()?;
        let tok = self.peek()?;
        if tok.t != Tok::Eof {
            let message = format!("Unexpected {}", self.describe(&tok));
            return self.unexpected(&tok, message);
        }
        Ok(expr)
    }

    // ── Characters ──

    fn src(&self) -> &'a Utf16 {
        self.sc.src
    }

    fn limit(&self) -> usize {
        self.sc.limit
    }

    /// The unit at the cursor (plus `offset`), inside the window.
    fn ch(&self, offset: usize) -> Option<u16> {
        self.sc.at(self.pos + offset)
    }

    fn ch_is(&self, offset: usize, c: char) -> bool {
        opt_is(self.ch(offset), c)
    }

    /// `this.src[i]`: unbounded by the window, as the TypeScript reads it.
    fn raw_is(&self, i: usize, c: char) -> bool {
        opt_is(self.src().at(i), c)
    }

    /// A token that cannot stand here. `|`, `?` and `;` lex only for the type
    /// grammar; anywhere else they are characters an author reached for from
    /// another language, and are refused as such.
    fn unexpected<T>(&self, tok: &Token, message: String) -> PResult<T> {
        if let Tok::Punct(p @ ("|" | "?" | ";")) = tok.t {
            return fail(unrecognised_character_message(p), tok.start);
        }
        fail(message, tok.start)
    }

    fn describe(&self, tok: &Token) -> String {
        match tok.t {
            Tok::Eof => "end of input".to_string(),
            Tok::Hop => "a hop '-['".to_string(),
            _ => format!("'{}'", self.src().text(tok.start, tok.end)),
        }
    }

    fn skip_ws(&mut self) {
        self.pos = self.sc.skip_ws(self.pos).0;
    }

    /// The index of the next space-or-tab-free unit at or after `i`.
    fn look_past(&self, mut i: usize) -> usize {
        while self.sc.at(i).is_some_and(|u| u == unit(' ') || u == unit('\t')) {
            i += 1;
        }
        i
    }

    fn look_past_all(&self, mut i: usize) -> usize {
        while self.sc.at(i).is_some_and(is_js_space) {
            i += 1;
        }
        i
    }

    fn rest(&self) -> &'a [u16] {
        self.src().slice(self.pos, self.limit())
    }

    // ── Tokens ──

    fn peek(&mut self) -> PResult<Token> {
        if let Some((pos, previous, token)) = &self.cache
            && *pos == self.pos
            && *previous == self.previous
        {
            return Ok(token.clone());
        }
        let token = self.sc.lex(self.pos, self.previous)?;
        self.cache = Some((self.pos, self.previous, token.clone()));
        Ok(token)
    }

    fn advance(&mut self) -> PResult<Token> {
        let tok = self.peek()?;
        self.pos = tok.end;
        self.last_end = tok.end;
        self.previous = match tok.t {
            Tok::Op(_) | Tok::Punct("(" | ",") => Previous::Opener,
            _ => Previous::Operand,
        };
        Ok(tok)
    }

    /// Put the cursor straight after text the parser read by character.
    fn consumed_to(&mut self, end: usize) {
        self.pos = end;
        self.last_end = end;
        self.previous = Previous::Operand;
    }

    fn can_continue(&self, tok: &Token) -> bool {
        !(self.stop_at_newline && tok.newline_before)
    }

    fn peek_is_punct(&mut self, text: &str) -> PResult<bool> {
        Ok(self.peek()?.is_punct(text))
    }

    fn expect_punct(&mut self, text: &str, context: &str) -> PResult<Token> {
        let tok = self.peek()?;
        if !tok.is_punct(text) {
            let message = format!("Expected '{text}' {context}, got {}", self.describe(&tok));
            return self.unexpected(&tok, message);
        }
        self.advance()
    }

    fn expect_op(&mut self, text: &str, context: &str) -> PResult<Token> {
        let tok = self.peek()?;
        if !tok.is_op(text) {
            let message = format!("Expected '{text}' {context}, got {}", self.describe(&tok));
            return self.unexpected(&tok, message);
        }
        self.advance()
    }

    fn expect_keyword(&mut self, text: &str, context: &str) -> PResult<Token> {
        let tok = self.peek()?;
        if !tok.is_keyword(text) {
            let message = format!("Expected {text} {context}, got {}", self.describe(&tok));
            return self.unexpected(&tok, message);
        }
        self.advance()
    }

    fn read_name(&mut self, context: &str) -> PResult<Name> {
        let tok = self.peek()?;
        let Tok::Name { text, quoted } = &tok.t else {
            let message = format!("Expected a name {context}, got {}", self.describe(&tok));
            return self.unexpected(&tok, message);
        };
        let name = Name { text: text.clone(), quoted: *quoted, at: At { start: tok.start, end: tok.end } };
        self.advance()?;
        Ok(name)
    }

    fn span(&self, start: usize) -> At {
        At { start, end: self.last_end }
    }

    /// Run `body` with entry-level newline termination switched on or off.
    fn with_newlines<T>(&mut self, stop: bool, body: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
        let saved = self.stop_at_newline;
        self.stop_at_newline = stop;
        let result = body(self);
        self.stop_at_newline = saved;
        result
    }

    /// One level of the grammar's recursion, bounded so that a deeply nested
    /// text is refused rather than overflowing the stack.
    fn nested<T>(&mut self, body: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
        if self.depth >= MAX_DEPTH {
            return fail(TOO_DEEP, self.pos);
        }
        self.depth += 1;
        let result = body(self);
        self.depth -= 1;
        result
    }

    // ── Precedence levels ──

    fn parse_where(&mut self) -> PResult<MExpr> {
        let start = self.peek()?.start;
        let source = self.parse_or()?;
        let tok = self.peek()?;
        if tok.is_word("WHERE") && self.can_continue(&tok) {
            self.advance()?;
            let predicate = self.parse_or()?;
            return Ok(MExpr::Where { source: Box::new(source), predicate: Box::new(predicate), at: self.span(start) });
        }
        Ok(source)
    }

    fn parse_binary_level(
        &mut self,
        next: fn(&mut Self) -> PResult<MExpr>,
        ops: fn(&Token) -> Option<BinaryOp>,
    ) -> PResult<MExpr> {
        let start = self.peek()?.start;
        let mut left = next(self)?;
        loop {
            let tok = self.peek()?;
            if !self.can_continue(&tok) {
                return Ok(left);
            }
            let Some(op) = ops(&tok) else {
                return Ok(left);
            };
            self.advance()?;
            let right = next(self)?;
            left = MExpr::Binary { op, left: Box::new(left), right: Box::new(right), at: self.span(start) };
        }
    }

    fn parse_or(&mut self) -> PResult<MExpr> {
        self.parse_binary_level(Self::parse_and, |tok| tok.is_keyword("OR").then_some(BinaryOp::Or))
    }

    fn parse_and(&mut self) -> PResult<MExpr> {
        self.parse_binary_level(Self::parse_not, |tok| tok.is_keyword("AND").then_some(BinaryOp::And))
    }

    fn parse_not(&mut self) -> PResult<MExpr> {
        let tok = self.peek()?;
        if tok.is_keyword("NOT") {
            self.advance()?;
            let operand = self.nested(Self::parse_not)?;
            return Ok(MExpr::Unary { op: UnaryOp::Not, operand: Box::new(operand), at: self.span(tok.start) });
        }
        self.parse_compare()
    }

    fn parse_compare(&mut self) -> PResult<MExpr> {
        let start = self.peek()?.start;
        let left = self.parse_add()?;
        let tok = self.peek()?;
        if !self.can_continue(&tok) {
            return Ok(left);
        }
        let symbolic = match tok.t {
            Tok::Op("=" | "==") => Some(BinaryOp::Eq),
            Tok::Op("!=") => Some(BinaryOp::Ne),
            Tok::Op("<") => Some(BinaryOp::Lt),
            Tok::Op("<=") => Some(BinaryOp::Le),
            Tok::Op(">") => Some(BinaryOp::Gt),
            Tok::Op(">=") => Some(BinaryOp::Ge),
            Tok::Keyword("CONTAINS") => Some(BinaryOp::Contains),
            Tok::Keyword("IN") => Some(BinaryOp::In),
            _ => None,
        };
        if let Some(op) = symbolic {
            self.advance()?;
            let right = self.parse_add()?;
            return Ok(MExpr::Binary { op, left: Box::new(left), right: Box::new(right), at: self.span(start) });
        }
        if tok.is_keyword("EXISTS") {
            self.advance()?;
            return Ok(MExpr::Exists { operand: Box::new(left), at: self.span(start) });
        }
        // `WITHIN` is read whether or not it is backtick-quoted, as the formula
        // grammar reads it; IS only bare.
        if matches!(&tok.t, Tok::Name { text, .. } if text.to_uppercase() == "WITHIN") {
            self.advance()?;
            let duration = self.parse_duration()?;
            return Ok(MExpr::Within { operand: Box::new(left), duration, at: self.span(start) });
        }
        if tok.is_word("IS") {
            self.advance()?;
            let type_start = self.last_end;
            let type_ = match self.parse_type_marker("after IS") {
                Ok(type_) => type_,
                Err(e) => {
                    self.refuse_is_type(type_start)?;
                    return Err(e);
                }
            };
            return Ok(MExpr::Is { subject: Box::new(left), type_, at: self.span(start) });
        }
        Ok(left)
    }

    /// The fix-it for a type after IS written without its angle brackets, or
    /// in the retired dotted spelling. A bracketed type with a fault inside
    /// keeps the parser's own, more precise, error.
    fn refuse_is_type(&self, from: usize) -> PResult<()> {
        let rest = self.src().slice(from, self.limit());
        let lead = rest.len() - trim_start(rest).len();
        let rhs = trim(before_and_or(trim(rest)));
        let at = from + lead;
        let rhs_text = to_string(rhs);
        if let Some((object, edge)) = dotted_type(rhs) {
            return fail(
                format!(
                    "'.' reads a property — a type names an EDGE, and an edge is an address. Write '<{object}-[:{edge}]->>' instead of '<{object}.{edge}>'."
                ),
                at,
            );
        }
        if is_bare_type(rhs) {
            return fail(
                format!("Types are written in angle brackets — wrap the type in angle brackets: <{rhs_text}>"),
                at,
            );
        }
        if rhs.first() != Some(&unit('<')) {
            return fail(
                format!(
                    "IS expects a position type in angle brackets like <graph> or <graph-[:position]->>, got \"{rhs_text}\""
                ),
                at,
            );
        }
        Ok(())
    }

    fn parse_duration(&mut self) -> PResult<Duration> {
        let tok = self.peek()?;
        if let Some(text) = tok.plain_string() {
            self.advance()?;
            return Ok(Duration { text, quoted: true, at: At { start: tok.start, end: tok.end } });
        }
        if let Tok::Number(number) = &tok.t {
            self.advance()?;
            let unit_tok = self.peek()?;
            if let Tok::Name { text, .. } = &unit_tok.t
                && unit_tok.start == tok.end
                && text.len() == 1
                && "smhdwSMHDW".contains(text.as_str())
            {
                self.advance()?;
                return Ok(Duration {
                    text: format!("{number}{text}"),
                    quoted: false,
                    at: At { start: tok.start, end: unit_tok.end },
                });
            }
        }
        fail("WITHIN expects a duration like 30d, 12h, or 1w", tok.start)
    }

    fn parse_add(&mut self) -> PResult<MExpr> {
        self.parse_binary_level(Self::parse_mul, |tok| match tok.t {
            Tok::Op("+") => Some(BinaryOp::Add),
            Tok::Op("-") => Some(BinaryOp::Sub),
            _ => None,
        })
    }

    fn parse_mul(&mut self) -> PResult<MExpr> {
        self.parse_binary_level(Self::parse_unary, |tok| match tok.t {
            Tok::Op("*") => Some(BinaryOp::Mul),
            Tok::Op("/") => Some(BinaryOp::Div),
            Tok::Op("%") => Some(BinaryOp::Rem),
            _ => None,
        })
    }

    fn parse_unary(&mut self) -> PResult<MExpr> {
        let tok = self.peek()?;
        if tok.is_op("-") {
            self.advance()?;
            let operand = self.nested(Self::parse_unary)?;
            return Ok(MExpr::Unary { op: UnaryOp::Neg, operand: Box::new(operand), at: self.span(tok.start) });
        }
        self.parse_postfix()
    }

    /// Every cycle in the expression grammar passes through here (a call's
    /// arguments and an index recurse from the postfix loop, not from the
    /// primary), so this is where the depth is counted.
    fn parse_postfix(&mut self) -> PResult<MExpr> {
        self.nested(Self::parse_postfix_inner)
    }

    fn parse_postfix_inner(&mut self) -> PResult<MExpr> {
        let start = self.peek()?.start;
        let mut expr = self.parse_primary()?;
        loop {
            let tok = self.peek()?;
            if !self.can_continue(&tok) {
                return Ok(expr);
            }
            if tok.is_op(".") {
                self.advance()?;
                let property = self.read_name("after '.'")?;
                expr = MExpr::Member { object: Box::new(expr), property, at: self.span(start) };
                continue;
            }
            if tok.is_punct("(") && matches!(expr, MExpr::Name { .. } | MExpr::Member { .. }) {
                let args = self.parse_call_args()?;
                expr = MExpr::Call { callee: Box::new(expr), args, at: self.span(start) };
                continue;
            }
            if tok.t == Tok::Hop {
                let hops = self.parse_hops()?;
                expr = MExpr::Path { root: Some(Box::new(expr)), hops, at: self.span(start) };
                continue;
            }
            if tok.is_punct("[") && !tok.space_before {
                self.advance()?;
                let index = self.with_newlines(false, Self::parse_where)?;
                self.expect_punct("]", "to close the index")?;
                expr = MExpr::Index { object: Box::new(expr), index: Box::new(index), at: self.span(start) };
                continue;
            }
            return Ok(expr);
        }
    }

    fn parse_call_args(&mut self) -> PResult<Vec<CallArg>> {
        self.expect_punct("(", "to open the arguments")?;
        self.with_newlines(false, |p| {
            let mut args = Vec::new();
            if p.peek_is_punct(")")? {
                p.advance()?;
                return Ok(args);
            }
            loop {
                let mut name = None;
                let first = p.peek()?;
                if let Tok::Name { text, quoted } = &first.t {
                    let save = p.pos;
                    let saved_previous = p.previous;
                    p.advance()?;
                    if p.peek_is_punct(":")? {
                        p.advance()?;
                        name = Some(Name {
                            text: text.clone(),
                            quoted: *quoted,
                            at: At { start: first.start, end: first.end },
                        });
                    } else {
                        p.pos = save;
                        p.previous = saved_previous;
                    }
                }
                let value = p.parse_where()?;
                args.push(CallArg { name, value });
                if p.peek_is_punct(",")? {
                    p.advance()?;
                    continue;
                }
                p.expect_punct(")", "to close the arguments")?;
                return Ok(args);
            }
        })
    }

    // ── Primaries ──

    fn parse_primary(&mut self) -> PResult<MExpr> {
        let tok = self.peek()?;
        let at = At { start: tok.start, end: tok.end };
        match &tok.t {
            Tok::Number(text) => {
                self.advance()?;
                let value = if text.contains('.') { parse_float(text) } else { parse_int(text) };
                return Ok(MExpr::Literal { value: LiteralValue::Number(JsNumber(value)), at });
            }
            Tok::String { quote, segments } => {
                self.advance()?;
                let parts = segments.iter().map(|s| self.interpolation(s)).collect::<PResult<Vec<_>>>()?;
                let quote = match quote {
                    QuoteChar::Double => Quote::Double,
                    QuoteChar::Single => Quote::Single,
                };
                return Ok(MExpr::String { quote, parts, at });
            }
            Tok::Special(text) => {
                self.advance()?;
                return Ok(MExpr::Special { text: text.clone(), at });
            }
            Tok::Hop => {
                let hops = self.parse_hops()?;
                return Ok(MExpr::Path { root: None, hops, at: self.span(tok.start) });
            }
            Tok::Keyword(keyword) => return self.parse_keyword_primary(&tok, keyword),
            Tok::Name { .. } => return self.parse_name_primary(&tok),
            Tok::Op("<") => {
                let type_ = self.parse_type_marker("as a value")?;
                let at = type_.at();
                return Ok(MExpr::Type { type_, at });
            }
            Tok::Punct("(") => {
                return match self.try_parse_closure()? {
                    Some(closure) => Ok(closure),
                    None => self.parse_paren(),
                };
            }
            Tok::Punct("[") => return self.parse_list(),
            Tok::Punct("{") => {
                let map = self.parse_map()?;
                return Ok(MExpr::Map { entries: map.entries, at: map.at });
            }
            Tok::Punct("...") => {
                return fail(
                    "'...' splices a list's members into a list literal — it is written only inside '[ … ]'",
                    tok.start,
                );
            }
            Tok::Eof => return fail("Unexpected end of input", tok.start),
            Tok::Op(_) | Tok::Punct(_) => {}
        }
        let message = format!("Unexpected {}", self.describe(&tok));
        self.unexpected(&tok, message)
    }

    fn interpolation(&self, segment: &Segment) -> PResult<StringPart> {
        match segment {
            Segment::Text(text) => Ok(StringPart::Text(text.clone())),
            Segment::Interpolation(span) => {
                if trim(self.src().slice(span.start, span.end)).is_empty() {
                    return fail("Empty ${…} interpolation", span.start - 2);
                }
                let mut inner = ExpressionParser::new(self.src(), span.start, span.end, self.depth + 1);
                Ok(StringPart::Expr(inner.parse_whole()?))
            }
        }
    }

    fn parse_keyword_primary(&mut self, tok: &Token, keyword: &str) -> PResult<MExpr> {
        let at = At { start: tok.start, end: tok.end };
        match keyword {
            "TRUE" | "FALSE" | "NULL" => {
                self.advance()?;
                let value = match keyword {
                    "NULL" => LiteralValue::Null(()),
                    _ => LiteralValue::Bool(keyword == "TRUE"),
                };
                Ok(MExpr::Literal { value, at })
            }
            "IF" => self.parse_if(),
            "EXISTS" => {
                // Prefix EXISTS(…) is a call like any other; the keyword stays
                // the postfix operator (`x EXISTS`).
                self.advance()?;
                if !self.peek_is_punct("(")? {
                    return fail("Unexpected EXISTS", tok.start);
                }
                let written = self.src().text(tok.start, tok.end);
                Ok(MExpr::Name { name: Name { text: written, quoted: false, at }, at })
            }
            "CONTAINS" => fail("CONTAINS is written between its operands — 'a CONTAINS b', not 'CONTAINS(a, b)'", tok.start),
            _ => fail(format!("Unexpected {keyword}"), tok.start),
        }
    }

    fn parse_name_primary(&mut self, tok: &Token) -> PResult<MExpr> {
        if tok.is_bare_name("node") {
            let after = self.look_past(tok.end);
            if self.raw_is(after, '{') {
                return self.parse_node_literal();
            }
            if self.at_declaration(after) {
                return self.parse_inline_declaration();
            }
        }
        if tok.is_bare_name("graph") && self.at_graph_literal(tok.end) {
            return self.parse_graph_literal();
        }
        let name = self.read_name("")?;
        let at = name.at;
        Ok(MExpr::Name { name, at })
    }

    fn parse_paren(&mut self) -> PResult<MExpr> {
        let open = self.advance()?;
        let expr = self.with_newlines(false, Self::parse_where)?;
        self.expect_punct(")", "to close '('")?;
        Ok(MExpr::Paren { expr: Box::new(expr), at: self.span(open.start) })
    }

    fn parse_if(&mut self) -> PResult<MExpr> {
        self.nested(Self::parse_if_inner)
    }

    fn parse_if_inner(&mut self) -> PResult<MExpr> {
        let start = self.expect_keyword("IF", "")?.start;
        let open = self.look_past(self.pos);
        if let Some(message) = call_style_if_message(self.src().slice(0, self.limit()), open) {
            return fail(message, start);
        }
        self.with_newlines(false, |p| {
            let condition = Box::new(p.parse_or()?);
            p.expect_keyword("THEN", "after the IF condition")?;
            let then = Box::new(p.parse_or()?);
            if p.peek()?.is_keyword("ELSE") {
                p.advance()?;
                if p.peek()?.is_keyword("IF") {
                    // The chain form: one END closes the whole chain, and an
                    // explicit END per IF is accepted too — the formula
                    // grammar's rule.
                    let else_if = p.parse_if()?;
                    if p.peek()?.is_keyword("END") {
                        p.advance()?;
                    }
                    return Ok(MExpr::If { condition, then, else_: Some(Box::new(else_if)), at: p.span(start) });
                }
                let otherwise = p.parse_or()?;
                p.expect_keyword("END", "to close the IF")?;
                return Ok(MExpr::If { condition, then, else_: Some(Box::new(otherwise)), at: p.span(start) });
            }
            p.expect_keyword("END", "to close the IF")?;
            Ok(MExpr::If { condition, then, else_: None, at: p.span(start) })
        })
    }

    fn parse_list(&mut self) -> PResult<MExpr> {
        let open = self.advance()?;
        self.with_newlines(false, |p| {
            let mut elements = Vec::new();
            while !p.peek_is_punct("]")? {
                let tok = p.peek()?;
                if tok.is_punct("...") {
                    p.advance()?;
                    let expr = p.parse_where()?;
                    elements.push(ListElement::Spread(Spread { expr, at: p.span(tok.start) }));
                } else {
                    elements.push(ListElement::Expr(p.parse_where()?));
                }
                if !p.peek_is_punct(",")? {
                    break;
                }
                p.advance()?;
            }
            p.expect_punct("]", "to close the list")?;
            Ok(MExpr::List { elements, at: p.span(open.start) })
        })
    }

    fn parse_map(&mut self) -> PResult<MapLiteral> {
        let open = self.advance()?;
        self.with_newlines(false, |p| {
            let mut entries = Vec::new();
            while !p.peek_is_punct("}")? {
                let tok = p.peek()?;
                if tok.is_punct("...") {
                    p.advance()?;
                    let expr = p.parse_where()?;
                    entries.push(MapMember::Spread(Spread { expr, at: p.span(tok.start) }));
                    if !p.peek_is_punct(",")? {
                        break;
                    }
                    p.advance()?;
                    continue;
                }
                let key = if let Tok::Name { .. } = tok.t {
                    MapKey::Name(p.read_name("as a map key")?)
                } else if let Some(text) = tok.plain_string() {
                    p.advance()?;
                    MapKey::String(StringKey {
                        text,
                        quoted: StringQuoted::String,
                        at: At { start: tok.start, end: tok.end },
                    })
                } else if let Tok::Keyword(keyword) = tok.t {
                    return fail(format!("'{keyword}' is a reserved word — quote it to use it as a map key"), tok.start);
                } else {
                    return fail(
                        format!(
                            "A map key is a name or a quoted string (or '...m' to copy a map's keys), got {}",
                            p.describe(&tok)
                        ),
                        tok.start,
                    );
                };
                let key_text = match &key {
                    MapKey::Name(name) => name.text.clone(),
                    MapKey::String(key) => key.text.clone(),
                };
                p.expect_punct(":", &format!("after the map key '{key_text}'"))?;
                let value = p.parse_where()?;
                entries.push(MapMember::Entry { key, value });
                if !p.peek_is_punct(",")? {
                    break;
                }
                p.advance()?;
            }
            p.expect_punct("}", "to close the map")?;
            Ok(MapLiteral { entries, at: p.span(open.start) })
        })
    }

    // ── Hops ──

    fn parse_hops(&mut self) -> PResult<Vec<Hop>> {
        let mut hops = Vec::new();
        loop {
            let tok = self.peek()?;
            if tok.t != Tok::Hop || (!hops.is_empty() && !self.can_continue(&tok)) {
                return Ok(hops);
            }
            hops.push(self.parse_hop(tok.start)?);
        }
    }

    /// One `-[…]->` / `<-[…]-`, read by character from `start`.
    fn parse_hop(&mut self, start: usize) -> PResult<Hop> {
        self.pos = start;
        let direction = if self.ch_is(0, '<') { Direction::In } else { Direction::Out };
        self.pos += if direction == Direction::In { 3 } else { 2 };
        self.skip_ws();
        let mut alias = None;
        if self.ch_is(0, ':') {
            self.pos += 1;
        } else if !self.ch_is(0, '#') {
            let alias_start = self.pos;
            let (text, quoted) = self.scan_bare_or_quoted()?;
            alias = Some(Name { text, quoted, at: At { start: alias_start, end: self.pos } });
            self.skip_ws();
            if !self.ch_is(0, ':') {
                return fail("Expected ':' after the hop's alias", self.pos);
            }
            self.pos += 1;
        }
        self.skip_ws();
        let label = self.read_label()?;
        self.skip_ws();

        let mut where_ = None;
        let mut config = None;
        if starts_with_ci(self.rest(), "WHERE") && self.rest().get(5).is_some_and(|&u| is_js_space(u)) {
            self.consumed_to(self.pos + 5);
            let rest = self.rest();
            if rest.get(space_run(rest)) == Some(&unit(']')) {
                return fail(
                    "a hop's WHERE needs a condition — write one after WHERE, or drop the WHERE to keep every landing",
                    self.pos,
                );
            }
            self.previous = Previous::Start;
            where_ = Some(self.with_newlines(false, Self::parse_or)?);
        } else if self.ch_is(0, '{') {
            self.previous = Previous::Start;
            config = Some(self.with_newlines(false, Self::parse_map)?);
        }
        self.skip_ws();

        let mut order_by = None;
        if let Some(len) = order_by_clause(self.rest()) {
            self.consumed_to(self.pos + len);
            self.previous = Previous::Start;
            let key = self.with_newlines(false, Self::parse_or)?;
            let dir = self.peek()?;
            let mut direction = None;
            if dir.is_word("ASC") || dir.is_word("DESC") {
                self.advance()?;
                direction = Some(if dir.is_word("DESC") { SortDirection::Desc } else { SortDirection::Asc });
            }
            order_by = Some(Box::new(OrderBy { key, direction }));
            self.skip_ws();
        }
        let mut limit = None;
        if let Some((len, digits)) = limit_clause(self.rest()) {
            limit = Some(JsNumber(parse_int(&digits)));
            self.pos += len;
            self.skip_ws();
        }
        if !self.ch_is(0, ']') {
            let got = if self.ch(0).is_some() { self.src().char_text(self.pos) } else { "end of input".to_string() };
            return fail(format!("Expected ']' to close the hop, got '{got}'"), self.pos);
        }
        self.pos += 1;
        let arrow = if direction == Direction::Out && self.ch_is(0, '-') && self.ch_is(1, '>') {
            self.pos += 2;
            Arrow::Full
        } else if self.ch_is(0, '-') {
            self.pos += 1;
            Arrow::Bare
        } else {
            let message = match direction {
                Direction::In => "Expected ']-' to close an incoming hop",
                Direction::Out => "Expected ']->' to close the hop",
            };
            return fail(message, self.pos);
        };
        self.consumed_to(self.pos);
        Ok(Hop { direction, arrow, alias, label, where_, config, order_by, limit, at: At { start, end: self.pos } })
    }

    fn scan_bare_or_quoted(&mut self) -> PResult<(String, bool)> {
        if self.ch_is(0, '`') {
            let (name, end) = self.sc.scan_backtick(self.pos)?;
            self.pos = end;
            return Ok((name, true));
        }
        let start = self.pos;
        if !self.ch(0).is_some_and(is_ident_start) {
            return fail("Expected a name", self.pos);
        }
        while self.ch(0).is_some_and(is_ident_char) {
            self.pos += 1;
        }
        Ok((self.src().text(start, self.pos), false))
    }

    /// A hop's label: backtick-quoted, or everything up to the bracket's next
    /// clause — `]`, a newline, a config `{`, ` WHERE `, ` ORDER BY ` or
    /// ` LIMIT ` — so an unquoted label may hold spaces (`-[:Funding Round]->`),
    /// a `#` (`#transform`) and a type shorthand (`_resources:TEXT`).
    fn read_label(&mut self) -> PResult<Name> {
        let start = self.pos;
        if self.ch_is(0, '`') {
            let (text, _) = self.scan_bare_or_quoted()?;
            return Ok(Name { text, quoted: true, at: At { start, end: self.pos } });
        }
        while let Some(c) = self.ch(0) {
            if c == unit(']') || c == unit('\n') || c == unit('{') {
                break;
            }
            if label_ends_at_clause(self.rest()) {
                break;
            }
            self.pos += 1;
        }
        let text = trim_end(self.src().slice(start, self.pos));
        if text.is_empty() {
            return fail("Expected an edge name in the hop", start);
        }
        Ok(Name { text: to_string(text), quoted: false, at: At { start, end: start + text.len() } })
    }

    // ── Types ──

    /// `<…>` — with the cursor on `<`.
    fn parse_type_marker(&mut self, context: &str) -> PResult<TypeExpr> {
        let open = self.peek()?;
        if !open.is_op("<") {
            return fail(
                format!("Expected a type in angle brackets {context}, got {}", self.describe(&open)),
                open.start,
            );
        }
        self.advance()?;
        let type_ = self.with_newlines(false, Self::parse_type_union)?;
        let close = self.peek()?;
        // `->>` closes a hop then the marker: the hop reader took `]->`.
        if !close.is_op(">") && !close.is_op(">=") {
            return fail(format!("Expected '>' to close the type, got {}", self.describe(&close)), close.start);
        }
        self.expect_op(">", "to close the type")?;
        Ok(type_)
    }

    fn parse_type_union(&mut self) -> PResult<TypeExpr> {
        let start = self.peek()?.start;
        let mut members = vec![self.parse_type_atom()?];
        while self.peek_is_punct("|")? {
            self.advance()?;
            members.push(self.parse_type_atom()?);
        }
        if members.len() == 1 {
            return Ok(members.remove(0));
        }
        Ok(TypeExpr::Union { members, at: self.span(start) })
    }

    fn parse_type_atom(&mut self) -> PResult<TypeExpr> {
        self.nested(Self::parse_type_atom_inner)
    }

    fn parse_type_atom_inner(&mut self) -> PResult<TypeExpr> {
        let tok = self.peek()?;
        let at = At { start: tok.start, end: tok.end };
        if let Some(text) = tok.plain_string() {
            self.advance()?;
            return Ok(TypeExpr::Literal { value: Some(text), at });
        }
        if tok.is_keyword("NULL") {
            self.advance()?;
            return Ok(TypeExpr::Literal { value: None, at });
        }
        if tok.is_punct("{") {
            self.advance()?;
            let mut members = Vec::new();
            while !self.peek_is_punct("}")? {
                let name = self.read_name("as a record member")?;
                let optional = self.peek_is_punct("?")?;
                if optional {
                    self.advance()?;
                }
                self.expect_punct(":", &format!("after the record member '{}'", name.text))?;
                let type_ = self.parse_type_union()?;
                members.push(RecordMember { name, optional, type_ });
                if !self.peek_is_punct(",")? {
                    break;
                }
                self.advance()?;
            }
            self.expect_punct("}", "to close the record type")?;
            let array = self.try_array_suffix()?;
            return Ok(TypeExpr::Record { members, array, at: self.span(tok.start) });
        }
        let name = self.read_name("in the type")?;
        let hops = if self.peek()?.t == Tok::Hop { self.parse_hops()? } else { Vec::new() };
        let mut field = None;
        if !hops.is_empty() && self.peek()?.is_op(".") {
            self.advance()?;
            field = Some(self.read_name("after '.' in the borrowed type")?);
        }
        let array = self.try_array_suffix()?;
        Ok(TypeExpr::Named { name, hops, field, array, at: self.span(tok.start) })
    }

    fn try_array_suffix(&mut self) -> PResult<bool> {
        let open = self.peek()?;
        if !open.is_punct("[") || open.space_before {
            return Ok(false);
        }
        self.advance()?;
        self.expect_punct("]", "to close '[]'")?;
        Ok(true)
    }

    // ── Closures ──

    /// `(params) => body` — told from a parenthesised expression by the `=>`
    /// after the balanced parameter list, so it costs a scan and nothing else.
    fn try_parse_closure(&mut self) -> PResult<Option<MExpr>> {
        let open = self.peek()?;
        let Some(close) = self.sc.matching_close(open.start) else {
            return Ok(None);
        };
        let i = self.look_past_all(close + 1);
        if !self.src().starts_with(i, "=>") {
            return Ok(None);
        }

        self.advance()?;
        let params = self.with_newlines(false, |p| {
            let mut params = Vec::new();
            while !p.peek_is_punct(")")? {
                let name = p.read_name("as a closure parameter")?;
                let mut type_ = None;
                if p.peek_is_punct(":")? {
                    p.advance()?;
                    type_ = Some(p.parse_type_marker(&format!("for the parameter '{}'", name.text))?);
                }
                params.push(Param { name, type_ });
                if !p.peek_is_punct(",")? {
                    break;
                }
                p.advance()?;
            }
            p.expect_punct(")", "to close the parameter list")?;
            Ok(params)
        })?;
        self.expect_op("=>", "between a closure's parameters and its body")?;
        let body_tok = self.peek()?;
        if body_tok.is_punct("{") {
            let Some(end) = self.sc.matching_close(body_tok.start) else {
                return fail("Expected '}' to close the closure body", body_tok.start);
            };
            self.consumed_to(end + 1);
            return Ok(Some(MExpr::Closure {
                params,
                body: Box::new(ClosureBody::Block { at: At { start: body_tok.start, end: end + 1 } }),
                at: self.span(open.start),
            }));
        }
        let expr = self.parse_where()?;
        Ok(Some(MExpr::Closure { params, body: Box::new(ClosureBody::Expr { expr }), at: self.span(open.start) }))
    }

    // ── Node and graph literals, inline declarations ──

    fn parse_node_literal(&mut self) -> PResult<MExpr> {
        let word = self.advance()?;
        let (entries, _) = self.parse_entry_body(Body::Node)?;
        Ok(MExpr::Node { entries, at: self.span(word.start) })
    }

    fn parse_node_entry_value(&mut self) -> PResult<EntryValue> {
        let tok = self.peek()?;
        if tok.is_op("<") {
            let type_ = self.parse_type_marker("for the declared edge")?;
            let sequenced = self.try_order_by()?;
            return Ok(EntryValue::DeclaredEdge(DeclaredEdge { type_, sequenced, at: self.span(tok.start) }));
        }
        // `lazy` is contextual, as in the statement grammar: a modifier only
        // when something that can begin a walk follows it.
        let lazy = tok.is_bare_name("lazy")
            && self
                .src()
                .at(self.look_past(tok.end))
                .is_some_and(|u| u == unit('-') || u == unit('`') || is_ident_start(u));
        if lazy {
            self.advance()?;
        }
        let value = self.parse_where()?;
        let walk = self.try_mapped_tail(value, Body::Node)?;
        if lazy {
            return Ok(EntryValue::Expr(MExpr::Lazy { walk: Box::new(walk), at: self.span(tok.start) }));
        }
        Ok(EntryValue::Expr(walk))
    }

    /// `order by arrival` — same line only, like every entry continuation.
    fn try_order_by(&mut self) -> PResult<Option<Name>> {
        let order = self.peek()?;
        if order.newline_before || !order.is_bare_name("order") {
            return Ok(None);
        }
        self.advance()?;
        let by = self.peek()?;
        if !by.is_bare_name("by") {
            return fail("An order is written 'order by'", by.start);
        }
        self.advance()?;
        Ok(Some(self.read_name("after 'order by'")?))
    }

    /// `walk node { … }` / `walk { … }` — a per-item mapping written after a walk.
    fn try_mapped_tail(&mut self, value: MExpr, body: Body) -> PResult<MExpr> {
        if !matches!(value, MExpr::Path { .. }) {
            return Ok(value);
        }
        let next = self.peek()?;
        if next.newline_before {
            return Ok(value);
        }
        let mapping = match body {
            Body::Node => {
                if next.is_bare_name("node") && self.raw_is(self.look_past(next.end), '{') {
                    Some(self.parse_node_literal()?)
                } else {
                    None
                }
            }
            Body::Graph => {
                if next.is_punct("{") {
                    Some(self.parse_graph_body(next.start, None)?)
                } else {
                    None
                }
            }
        };
        let Some(mapping) = mapping else {
            return Ok(value);
        };
        let at = At { start: value.at().start, end: mapping.at().end };
        Ok(MExpr::Mapped { source: Box::new(value), body: Box::new(mapping), at })
    }

    /// `{ name: value, … }` with entries ended by a comma, a newline or the
    /// close — and, for a graph body, `...spread` members.
    fn parse_entry_body(&mut self, body: Body) -> PResult<(Vec<LiteralEntry>, Vec<MExpr>)> {
        self.nested(|p| p.parse_entry_body_inner(body))
    }

    fn parse_entry_body_inner(&mut self, body: Body) -> PResult<(Vec<LiteralEntry>, Vec<MExpr>)> {
        let what = body.what();
        self.expect_punct("{", &format!("to open {what}"))?;
        let mut entries = Vec::new();
        let mut spreads = Vec::new();
        self.with_newlines(true, |p| {
            loop {
                let tok = p.peek()?;
                if tok.is_punct("}") {
                    break;
                }
                if tok.is_punct(",") {
                    p.advance()?;
                    continue;
                }
                if body == Body::Graph && tok.is_punct("...") {
                    p.advance()?;
                    spreads.push(p.parse_postfix()?);
                } else {
                    let name = p.read_name(&format!("as an entry name in {what}"))?;
                    p.expect_punct(":", &format!("after the entry name '{}'", name.text))?;
                    let value = match body {
                        Body::Node => p.parse_node_entry_value()?,
                        Body::Graph => EntryValue::Expr(p.parse_graph_entry_value()?),
                    };
                    let at = p.span(name.at.start);
                    entries.push(LiteralEntry { name, value, at });
                }
                let sep = p.peek()?;
                if sep.is_punct(",") {
                    p.advance()?;
                } else if !sep.is_punct("}") && !sep.newline_before {
                    return fail(
                        format!("Expected ',' or a newline after an entry in {what}, got {}", p.describe(&sep)),
                        sep.start,
                    );
                }
            }
            Ok(())
        })?;
        self.expect_punct("}", &format!("to close {what}"))?;
        Ok((entries, spreads))
    }

    fn at_graph_literal(&self, after_word: usize) -> bool {
        let i = self.look_past(after_word);
        if self.raw_is(i, '{') {
            return true;
        }
        if !self.raw_is(i, '<') {
            return false;
        }
        let i = self.look_past(i + 1);
        // Unbounded, as the TypeScript's `this.src.indexOf('>', i)`.
        match self.src().index_of(unit('>'), i) {
            Some(close) => self.raw_is(self.look_past(close + 1), '{'),
            None => false,
        }
    }

    fn parse_graph_literal(&mut self) -> PResult<MExpr> {
        let word = self.advance()?;
        let mut shape = None;
        if self.peek()?.is_op("<") {
            self.advance()?;
            shape = Some(self.read_name("inside 'graph<…>'")?);
            self.expect_op(">", "to close 'graph<…>'")?;
        }
        self.parse_graph_body(word.start, shape)
    }

    /// A graph body. Here `{` opens a CHILD NODE, never a map: the brace's
    /// meaning is decided by where it is written, as it is for a write body.
    fn parse_graph_body(&mut self, start: usize, shape: Option<Name>) -> PResult<MExpr> {
        let (entries, spreads) = self.parse_entry_body(Body::Graph)?;
        Ok(MExpr::Graph { shape, entries, spreads, at: self.span(start) })
    }

    fn parse_graph_entry_value(&mut self) -> PResult<MExpr> {
        let tok = self.peek()?;
        if tok.is_punct("{") {
            return self.parse_graph_body(tok.start, None);
        }
        if tok.is_punct("[") && self.raw_is(self.look_past_all(tok.end), '{') {
            self.advance()?;
            let bodies = self.with_newlines(false, |p| {
                let mut bodies = Vec::new();
                while !p.peek_is_punct("]")? {
                    let start = p.peek()?.start;
                    bodies.push(ListElement::Expr(p.parse_graph_body(start, None)?));
                    if !p.peek_is_punct(",")? {
                        break;
                    }
                    p.advance()?;
                }
                Ok(bodies)
            })?;
            self.expect_punct("]", "to close the list of child nodes")?;
            return Ok(MExpr::List { elements: bodies, at: self.span(tok.start) });
        }
        let value = self.parse_where()?;
        self.try_mapped_tail(value, Body::Graph)
    }

    /// `node Name extends Base: "…" {` / `node Name: "…" {` / `node Name {` — after `node`.
    fn at_declaration(&self, after: usize) -> bool {
        let sc = &self.sc;
        let Some(first) = sc.at(after) else {
            return false;
        };
        let mut i = if first == unit('`') {
            match sc.scan_backtick(after) {
                Ok((_, end)) => end,
                Err(_) => return false,
            }
        } else if is_ident_start(first) {
            let mut i = after;
            while sc.at(i).is_some_and(is_ident_char) {
                i += 1;
            }
            i
        } else {
            return false;
        };
        i = self.look_past(i);
        if self.src().starts_with(i, "extends") {
            return true;
        }
        if sc.is(i, ':') {
            return sc.is(self.look_past(i + 1), '"');
        }
        sc.is(i, '{')
    }

    fn parse_inline_declaration(&mut self) -> PResult<MExpr> {
        let declaration = self.parse_declaration()?;
        let at = declaration.at;
        Ok(MExpr::Declaration { declaration: Box::new(declaration), at })
    }

    fn parse_declaration(&mut self) -> PResult<NodeDeclaration> {
        self.nested(Self::parse_declaration_inner)
    }

    fn parse_declaration_inner(&mut self) -> PResult<NodeDeclaration> {
        let word = self.advance()?;
        let name = self.read_name("after 'node'")?;
        let mut extends = None;
        if self.peek()?.is_word("EXTENDS") {
            self.advance()?;
            extends = Some(self.read_name("after 'extends'")?);
        }
        let mut description = None;
        if self.peek_is_punct(":")? {
            self.advance()?;
            let primary = self.parse_primary()?;
            if !matches!(primary, MExpr::String { .. }) {
                return fail("A node declaration is described by a double-quoted string", primary.at().start);
            }
            description = Some(primary);
        }
        self.expect_punct("{", &format!("to open the node '{}'", name.text))?;
        let members = self.with_newlines(true, |p| {
            let mut members = Vec::new();
            loop {
                let tok = p.peek()?;
                if tok.is_punct("}") {
                    return Ok(members);
                }
                if tok.is_punct(",") || tok.is_punct(";") {
                    p.advance()?;
                    continue;
                }
                if tok.is_bare_name("node") {
                    let mut declaration = p.parse_declaration()?;
                    if let Some(sequenced) = p.try_order_by()? {
                        declaration.sequenced = Some(sequenced);
                    }
                    members.push(DeclarationMember::Node { declaration });
                    continue;
                }
                let field = p.read_name("as a field name")?;
                p.expect_punct(":", &format!("after the field name '{}'", field.text))?;
                let type_ = p.parse_type_marker(&format!("for the field '{}'", field.text))?;
                let next = p.peek()?;
                let description = if matches!(next.t, Tok::String { .. }) && !next.newline_before {
                    Some(p.parse_primary()?)
                } else {
                    None
                };
                let at = p.span(field.at.start);
                members.push(DeclarationMember::Field { name: field, type_, description, at });
            }
        })?;
        self.expect_punct("}", &format!("to close the node '{}'", name.text))?;
        Ok(NodeDeclaration { name, extends, description, members, sequenced: None, at: self.span(word.start) })
    }
}

/// `parseFloat` over `[0-9.]+` (with a leading `-`): the digits up to the
/// second dot.
fn parse_float(text: &str) -> f64 {
    let end = text.match_indices('.').nth(1).map_or(text.len(), |(i, _)| i);
    text[..end].parse().unwrap_or(f64::NAN)
}

/// `parseInt(text, 10)` over digits with an optional leading `-`.
fn parse_int(text: &str) -> f64 {
    text.parse().unwrap_or(f64::NAN)
}

/// `s.split(/\s+(?:AND|OR)\s/i)[0]`.
fn before_and_or(s: &[u16]) -> &[u16] {
    let mut i = 0;
    while i < s.len() {
        if is_js_space(s[i]) {
            let word = i + space_run(&s[i..]);
            let rest = &s[word..];
            let joins = |w: &str| starts_with_ci(rest, w) && rest.get(w.len()).is_some_and(|&u| is_js_space(u));
            if joins("AND") || joins("OR") {
                return &s[..i];
            }
            i = word;
        } else {
            i += 1;
        }
    }
    s
}

/// `` `[^`]+` `` or `[A-Za-z_][A-Za-z0-9_]*` at `i`: the end of the name.
fn name_at(s: &[u16], i: usize) -> Option<usize> {
    let first = *s.get(i)?;
    if first == unit('`') {
        let close = s.iter().skip(i + 1).position(|&u| u == unit('`'))? + i + 1;
        return (close > i + 1).then_some(close + 1);
    }
    if !is_ident_start(first) {
        return None;
    }
    Some(i + 1 + s[i + 1..].iter().take_while(|&&u| is_ident_char(u)).count())
}

/// `IS_DOTTED_TYPE` — `crm.company` / `<crm.company>`, the retired dotted
/// spelling: its two names as written.
fn dotted_type(s: &[u16]) -> Option<(String, String)> {
    let mut i = usize::from(s.first() == Some(&unit('<')));
    i += space_run(&s[i..]);
    let first_end = name_at(s, i)?;
    let first = to_string(&s[i..first_end]);
    i = first_end + space_run(&s[first_end..]);
    if s.get(i) != Some(&unit('.')) {
        return None;
    }
    i += 1;
    i += space_run(&s[i..]);
    let second_end = name_at(s, i)?;
    let second = to_string(&s[i..second_end]);
    i = second_end + space_run(&s[second_end..]);
    if s.get(i) == Some(&unit('>')) {
        i += 1;
    }
    (i == s.len()).then_some((first, second))
}

/// `IS_BARE_TYPE` — `crm` / `crm-[:company]->`, a type without its angle
/// brackets.
fn is_bare_type(s: &[u16]) -> bool {
    let Some(end) = name_at(s, 0) else {
        return false;
    };
    if end == s.len() {
        return true;
    }
    let mut i = end;
    let expect = |text: &str, i: &mut usize| {
        let units: Vec<u16> = text.encode_utf16().collect();
        let ok = s.get(*i..*i + units.len()) == Some(&units[..]);
        if ok {
            *i += units.len();
        }
        ok
    };
    if !expect("-[", &mut i) {
        return false;
    }
    i += space_run(&s[i..]);
    if !expect(":", &mut i) {
        return false;
    }
    i += space_run(&s[i..]);
    let Some(label_end) = name_at(s, i) else {
        return false;
    };
    i = label_end + space_run(&s[label_end..]);
    expect("]->", &mut i) && i == s.len()
}

/// `/^ORDER\s+BY\s+/i`: the length of the match.
fn order_by_clause(rest: &[u16]) -> Option<usize> {
    if !starts_with_ci(rest, "ORDER") {
        return None;
    }
    let gap = space_run(&rest[5..]);
    if gap == 0 || !starts_with_ci(&rest[5 + gap..], "BY") {
        return None;
    }
    let after = 5 + gap + 2;
    let tail = space_run(&rest[after..]);
    (tail > 0).then_some(after + tail)
}

/// `/^LIMIT\s+(\d+)/i`: the length of the match and the digits.
fn limit_clause(rest: &[u16]) -> Option<(usize, String)> {
    if !starts_with_ci(rest, "LIMIT") {
        return None;
    }
    let gap = space_run(&rest[5..]);
    let digits = rest[5 + gap..].iter().take_while(|&&u| is_ascii_digit(u)).count();
    if gap == 0 || digits == 0 {
        return None;
    }
    let end = 5 + gap + digits;
    Some((end, to_string(&rest[5 + gap..end])))
}

/// `/^\s+WHERE\s/i.test(rest) || /^\s+(ORDER\s+BY|LIMIT)\s/i.test(rest)`.
fn label_ends_at_clause(rest: &[u16]) -> bool {
    let gap = space_run(rest);
    if gap == 0 {
        return false;
    }
    let word = &rest[gap..];
    let then_space = |len: usize| word.get(len).is_some_and(|&u| is_js_space(u));
    if starts_with_ci(word, "WHERE") && then_space(5) || starts_with_ci(word, "LIMIT") && then_space(5) {
        return true;
    }
    if starts_with_ci(word, "ORDER") {
        let inner = space_run(&word[5..]);
        return inner > 0 && starts_with_ci(&word[5 + inner..], "BY") && then_space(5 + inner + 2);
    }
    false
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::tree::MAX_CHAIN;

    fn tree(text: &str) -> Value {
        match parse_expression(text) {
            Ok(tree) => serde_json::to_value(tree).unwrap(),
            Err(e) => panic!("{text:?} failed: {e:?}"),
        }
    }

    fn error(text: &str) -> (String, usize) {
        match parse_expression(text) {
            Ok(tree) => panic!("{text:?} parsed: {tree:?}"),
            Err(e) => (e.message, e.pos),
        }
    }

    fn at(start: usize, end: usize) -> Value {
        json!({ "start": start, "end": end })
    }

    #[test]
    fn binary_operators_climb_by_precedence() {
        let t = tree("a + b * c");
        assert_eq!(t["kind"], "binary");
        assert_eq!(t["op"], "+");
        assert_eq!(t["right"]["op"], "*");
        assert_eq!(t["at"], at(0, 9));
        let t = tree("a OR b AND NOT c");
        assert_eq!(t["op"], "or");
        assert_eq!(t["right"]["op"], "and");
        assert_eq!(t["right"]["right"]["kind"], "unary");
    }

    #[test]
    fn a_minus_after_an_operand_is_subtraction_and_before_one_a_literal() {
        assert_eq!(tree("a-1")["op"], "-");
        assert_eq!(tree("a - -1")["right"], json!({ "kind": "literal", "value": -1, "at": at(4, 6) }));
        assert_eq!(tree("-a")["kind"], "unary");
        assert_eq!(tree("1.5")["value"], 1.5);
        // parseFloat stops at the second dot.
        assert_eq!(tree("1.2.3")["value"], 1.2);
    }

    #[test]
    fn hops_walk_from_a_root_or_from_nowhere() {
        let t = tree("crm-[:Funding Round WHERE amount > 5 ORDER BY date DESC LIMIT 3]->.name");
        assert_eq!(t["kind"], "member");
        let hop = &t["object"]["hops"][0];
        assert_eq!(hop["label"], json!({ "text": "Funding Round", "quoted": false, "at": at(6, 19) }));
        assert_eq!(hop["where"]["op"], ">");
        assert_eq!(hop["orderBy"]["direction"], "desc");
        assert_eq!(hop["limit"], 3);
        assert_eq!(hop["arrow"], "->");
        assert!(hop.get("alias").is_none() && hop.get("config").is_none());

        let t = tree("<-[m:Messages]-");
        assert_eq!(t["kind"], "path");
        assert!(t.get("root").is_none());
        assert_eq!(t["hops"][0]["direction"], "in");
        assert_eq!(t["hops"][0]["alias"]["text"], "m");
        assert_eq!(t["hops"][0]["arrow"], "-");
    }

    #[test]
    fn a_minus_and_a_list_is_not_a_hop() {
        let t = tree("a-[1]");
        assert_eq!(t["op"], "-");
        assert_eq!(t["right"]["kind"], "list");
    }

    #[test]
    fn strings_interpolate_with_offsets_into_the_whole_text() {
        let t = tree(r#""a ${b.c} d""#);
        assert_eq!(t["quote"], "\"");
        assert_eq!(t["parts"][0], "a ");
        assert_eq!(t["parts"][1]["kind"], "member");
        assert_eq!(t["parts"][1]["at"], at(5, 8));
        assert_eq!(t["parts"][2], " d");
        assert_eq!(tree("'${x}'")["parts"], json!(["${x}"]));
        assert_eq!(error(r#""a ${ } b""#), ("Empty ${…} interpolation".into(), 3));
    }

    #[test]
    fn a_brace_inside_a_quoted_string_does_not_close_an_interpolation() {
        let t = tree(r#""${ f("}") }""#);
        assert_eq!(t["parts"][0]["kind"], "call");
        assert_eq!(t["parts"][0]["args"][0]["value"]["parts"], json!(["}"]));
    }

    #[test]
    fn map_entries_carry_no_kind() {
        let t = tree(r#"{ a: 1, "b c": 2, ...m }"#);
        let entries = t["entries"].as_array().unwrap();
        assert!(entries[0].get("kind").is_none());
        assert_eq!(entries[1]["key"]["quoted"], "string");
        assert_eq!(entries[2]["kind"], "spread");
        assert_eq!(error("{ IN: 1 }"), ("'IN' is a reserved word — quote it to use it as a map key".into(), 2));
    }

    #[test]
    fn keywords_are_case_insensitive_and_contextual_words_are_not_reserved() {
        assert_eq!(tree("a and b")["op"], "and");
        assert_eq!(tree("x where y")["kind"], "where");
        assert_eq!(tree("where")["kind"], "name");
        assert_eq!(tree("null")["value"], Value::Null);
        assert_eq!(tree("EXISTS(x)")["callee"]["name"]["text"], "EXISTS");
        assert_eq!(tree("exists(x)")["callee"]["name"]["text"], "exists");
        assert_eq!(tree("x EXISTS")["kind"], "exists");
    }

    #[test]
    fn within_reads_a_duration_written_or_quoted() {
        let t = tree("d WITHIN 30d");
        assert_eq!(t["duration"], json!({ "text": "30d", "quoted": false, "at": at(9, 12) }));
        assert_eq!(tree("d within \"2w\"")["duration"]["quoted"], true);
        assert_eq!(error("d WITHIN 30 d"), ("WITHIN expects a duration like 30d, 12h, or 1w".into(), 9));
    }

    #[test]
    fn is_takes_a_bracketed_type_and_refuses_the_others_with_a_fix() {
        assert_eq!(tree("x IS <crm-[:company]->>")["type"]["hops"][0]["label"]["text"], "company");
        assert_eq!(
            error("x IS crm AND y"),
            ("Types are written in angle brackets — wrap the type in angle brackets: <crm>".into(), 5)
        );
        assert_eq!(
            error("x IS crm.company"),
            (
                "'.' reads a property — a type names an EDGE, and an edge is an address. Write '<crm-[:company]->>' instead of '<crm.company>'."
                    .into(),
                5
            )
        );
        assert_eq!(
            error("x IS 5"),
            ("IS expects a position type in angle brackets like <graph> or <graph-[:position]->>, got \"5\"".into(), 5)
        );
    }

    #[test]
    fn types_as_values() {
        let t = tree("<{ a?: text, b: number[] } | \"x\" | null>");
        assert_eq!(t["kind"], "type");
        let members = t["type"]["members"].as_array().unwrap();
        assert_eq!(members[0]["members"][0]["optional"], true);
        assert_eq!(members[0]["members"][1]["type"]["array"], true);
        assert_eq!(members[1], json!({ "kind": "literal", "value": "x", "at": at(29, 32) }));
        assert_eq!(members[2]["value"], Value::Null);
    }

    #[test]
    fn closures_are_told_from_parens_by_the_arrow() {
        let t = tree("(x: <text>, y) => { return x }");
        assert_eq!(t["kind"], "closure");
        assert_eq!(t["body"], json!({ "kind": "block", "at": at(18, 30) }));
        assert!(t["params"][1].get("type").is_none());
        assert_eq!(tree("(x) => x + 1")["body"]["expr"]["kind"], "binary");
        assert_eq!(tree("(x)")["kind"], "paren");
    }

    #[test]
    fn if_chains_close_with_one_end() {
        let t = tree("IF a THEN 1 ELSE IF b THEN 2 ELSE 3 END");
        assert_eq!(t["else"]["kind"], "if");
        assert!(tree("IF a THEN 1 END").get("else").is_none());
        assert_eq!(
            error("IF(a, b, c)"),
            ("IF is written 'IF … THEN … ELSE … END', not called like a function — write 'IF a THEN b ELSE c END'".into(), 0)
        );
    }

    #[test]
    fn node_and_graph_literals_end_entries_at_newlines() {
        let t = tree("node {\n  a: 1\n  b: <text> order by arrival\n  c: lazy m-[x:Attachments]->\n}");
        let entries = t["entries"].as_array().unwrap();
        assert_eq!(entries[1]["value"]["kind"], "declaredEdge");
        assert_eq!(entries[1]["value"]["sequenced"]["text"], "arrival");
        assert_eq!(entries[2]["value"]["kind"], "lazy");
        let t = tree("graph<Shape> { a: { b: 1 }, ...rest, c: [{ d: 2 }], e: m-[x:A]-> { f: x } }");
        assert_eq!(t["shape"]["text"], "Shape");
        assert_eq!(t["entries"][0]["value"]["kind"], "graph");
        assert_eq!(t["spreads"][0]["kind"], "name");
        assert_eq!(t["entries"][1]["value"]["kind"], "list");
        assert_eq!(t["entries"][2]["value"]["kind"], "mapped");
        assert_eq!(
            error("node { a: 1 b: 2 }"),
            ("Expected ',' or a newline after an entry in the node literal, got 'b'".into(), 12)
        );
    }

    #[test]
    fn inline_declarations() {
        let t = tree("node Deal extends Base: \"A deal\" {\n  name: <text> \"its name\"\n  node Note { body: <text> } order by arrival\n}");
        assert_eq!(t["kind"], "declaration");
        let d = &t["declaration"];
        assert_eq!(d["extends"]["text"], "Base");
        assert_eq!(d["members"][0]["description"]["parts"], json!(["its name"]));
        assert_eq!(d["members"][1]["declaration"]["sequenced"]["text"], "arrival");
        assert!(d.get("sequenced").is_none());
    }

    #[test]
    fn stray_punctuation_is_refused_with_a_hint() {
        assert_eq!(error("a | b"), ("Unrecognised character '|' — write OR (not | or ||)".into(), 2));
        assert_eq!(
            error("a ? b : c"),
            ("Unrecognised character '?' — write IF … THEN … ELSE … END (there is no ? : conditional)".into(), 2)
        );
        assert_eq!(error("a &&b"), ("Unrecognised character '&' — write AND (not & or &&)".into(), 2));
    }

    #[test]
    fn messages_name_what_was_found() {
        assert_eq!(error(""), ("Unexpected end of input".into(), 0));
        assert_eq!(error("f(a"), ("Expected ')' to close the arguments, got end of input".into(), 3));
        assert_eq!(error("a b"), ("Unexpected 'b'".into(), 2));
        assert_eq!(error("(a]"), ("Expected ')' to close '(', got ']'".into(), 2));
        assert_eq!(error("...a"), ("'...' splices a list's members into a list literal — it is written only inside '[ … ]'".into(), 0));
        assert_eq!(error("CONTAINS(a, b)").0, "CONTAINS is written between its operands — 'a CONTAINS b', not 'CONTAINS(a, b)'");
        assert_eq!(error("a-[:x"), ("Expected ']' to close the hop, got 'end of input'".into(), 5));
        assert_eq!(error("a-[:x]>"), ("Expected ']->' to close the hop".into(), 6));
        assert_eq!(error("a-[:x WHERE ]->").0, "a hop's WHERE needs a condition — write one after WHERE, or drop the WHERE to keep every landing");
    }

    #[test]
    fn offsets_are_utf16_units_through_accents_and_emoji() {
        // 'é' is one unit; '🌍' is two.
        let t = tree("'café 🌍' + naive");
        assert_eq!(t["left"]["at"], at(0, 9));
        assert_eq!(t["left"]["parts"], json!(["café 🌍"]));
        assert_eq!(t["right"]["kind"], "name");
        let t = tree("`🌍 name`.x");
        assert_eq!(t["object"]["name"], json!({ "text": "🌍 name", "quoted": true, "at": at(0, 9) }));
        assert_eq!(t["property"]["at"], at(10, 11));
        let t = tree("m-[:Résumé 🌍]->.n");
        assert_eq!(t["object"]["hops"][0]["label"]["at"], at(4, 13));
        assert_eq!(t["at"], at(0, 18));
        let t = tree(r#""🌍${a}""#);
        assert_eq!(t["parts"][1]["at"], at(5, 6));
        assert_eq!(error("'🌍' – b"), ("Unrecognised character '–' — write the ASCII minus '-' (this is an en dash)".into(), 5));
        assert_eq!(error("'café 🌍' + naïve"), ("Unrecognised character 'ï'".into(), 14));
    }

    #[test]
    fn deep_nesting_is_refused_not_overflowed() {
        let deep = |open: &str, close: &str, n: usize| format!("{}a{}", open.repeat(n), close.repeat(n));
        // Run where a debug build's frames fit; the WASM stack is sized for
        // the limit in a release build (see scripts/build-movement-wasm.sh).
        let run = |text: String| std::thread::Builder::new()
            .stack_size(256 << 20)
            .spawn(move || parse_expression(&text).map(|_| ()).map_err(|e| e.message))
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(run(deep("(", ")", MAX_DEPTH - 1)), Ok(()));
        assert_eq!(run(deep("(", ")", MAX_DEPTH + 1)), Err(TOO_DEEP.to_string()));
        assert_eq!(run(deep("[", "]", 100_000)), Err(TOO_DEEP.to_string()));
        assert_eq!(run(deep("f(", ")", 100_000)), Err(TOO_DEEP.to_string()));
        assert_eq!(run(format!("a{}", deep("[", "]", 100_000))), Err(TOO_DEEP.to_string()));
        assert_eq!(run(deep("a-[:e WHERE ", "]->", 100_000)), Err(TOO_DEEP.to_string()));
        assert_eq!(run(format!("{}a", "NOT ".repeat(100_000))), Err(TOO_DEEP.to_string()));
        assert_eq!(run(format!("{}a", "- ".repeat(100_000))), Err(TOO_DEEP.to_string()));
        assert_eq!(run(deep("\"${", "}\"", 100_000)), Err(TOO_DEEP.to_string()));
        assert_eq!(run(format!("<{}x{}>", "{a:".repeat(100_000), "}".repeat(100_000))), Err(TOO_DEEP.to_string()));
        assert_eq!(run(deep("IF a THEN 1 ELSE ", " END", 100_000)), Err(TOO_DEEP.to_string()));
        assert_eq!(run(format!("node X {{{}}}", "node Y {".repeat(100_000))), Err(TOO_DEEP.to_string()));
        assert_eq!(run(format!("graph {{{}}}", "a: {".repeat(100_000))), Err(TOO_DEEP.to_string()));
    }

    /// `text`'s parse, serialised as the ABI would, on a thread whose stack
    /// is `stack` bytes.
    fn parse_on(stack: usize, text: String) -> Result<(), (String, usize)> {
        std::thread::Builder::new()
            .stack_size(stack)
            .spawn(move || {
                parse_expression(&text).map(|tree| drop(crate::to_sorted_json(&tree))).map_err(|e| (e.message, e.pos))
            })
            .unwrap()
            .join()
            .unwrap()
    }

    const ROOMY: usize = 256 << 20;
    /// Far too small to recurse over a chain of a million: what refuses one
    /// must walk, build and drop it with loops.
    const TIGHT: usize = 256 << 10;

    #[test]
    fn a_chain_is_bounded_at_its_limit() {
        let too_long = |pos| Err((CHAIN_TOO_LONG.to_string(), pos));
        // The tree's height is what is bounded: a name and 1,023 links.
        let members = |n: usize| format!("a{}", ".b".repeat(n));
        assert_eq!(parse_on(ROOMY, members(MAX_CHAIN - 1)), Ok(()));
        assert_eq!(parse_on(ROOMY, members(MAX_CHAIN)), too_long(0));
        let operands = |n: usize| format!("a{}", " + a".repeat(n));
        assert_eq!(parse_on(ROOMY, operands(MAX_CHAIN - 1)), Ok(()));
        assert_eq!(parse_on(ROOMY, operands(MAX_CHAIN)), too_long(0));
        let calls = |n: usize| format!("a{}", ".f()".repeat(n / 2));
        assert_eq!(parse_on(ROOMY, calls(MAX_CHAIN - 1)), Ok(()));
        assert_eq!(parse_on(ROOMY, calls(MAX_CHAIN + 1)), too_long(0));
        // A hop is a level of its lowering.
        let hops = |n: usize| format!("a{}", "-[:e]->".repeat(n));
        assert_eq!(parse_on(ROOMY, hops(MAX_CHAIN - 1)), Ok(()));
        assert_eq!(parse_on(ROOMY, hops(MAX_CHAIN)), too_long(0));
        // Arguments are a width, refused at the first past the limit.
        let args = |n: usize| format!("f({})", vec!["x"; n].join(", "));
        assert_eq!(parse_on(ROOMY, args(MAX_CHAIN)), Ok(()));
        assert_eq!(parse_on(ROOMY, args(MAX_CHAIN + 1)), too_long(2 + 3 * MAX_CHAIN));
        // Chains continued through parentheses are one chain.
        let stacked = format!("{}a{}", "(".repeat(4), ").b".repeat(4).replace(".b", &".b".repeat(300)));
        assert_eq!(parse_on(ROOMY, stacked).map_err(|(message, _)| message), Err(CHAIN_TOO_LONG.to_string()));
    }

    #[test]
    fn a_chain_far_past_the_limit_is_refused_without_recursing() {
        let too_long = Err((CHAIN_TOO_LONG.to_string(), 0));
        assert_eq!(parse_on(TIGHT, format!("a{}", ".b".repeat(1_000_000))), too_long);
        assert_eq!(parse_on(TIGHT, format!("a{}", " + a".repeat(1_000_000))), too_long);
        assert_eq!(parse_on(TIGHT, format!("a{}", "[0]".repeat(1_000_000))), too_long);
        // Few parentheses: the grammar's own recursion is not what is tested.
        let stacked = format!("{}a{}", "(".repeat(5), format!("){}", ".b".repeat(200_000)).repeat(5));
        assert_eq!(parse_on(TIGHT, stacked).map_err(|(message, _)| message), Err(CHAIN_TOO_LONG.to_string()));
        // A parse that fails after building the chain drops it as well.
        let failed = parse_on(TIGHT, format!("a{} +", ".b".repeat(1_000_000)));
        assert_eq!(failed.map_err(|(message, _)| message), Err("Unexpected end of input".to_string()));
    }
}
