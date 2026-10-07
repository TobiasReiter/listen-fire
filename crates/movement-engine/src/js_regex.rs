//! `new RegExp(pattern).exec(text)` with no flags, as JavaScript runs it: a
//! backtracking matcher over UTF-16 code units (no `u` flag, so an astral
//! character is two units), Annex B's lenient syntax, and the spec's
//! repetition rules — every iteration of a quantified group starts with that
//! group's captures cleared, and an iteration that matches nothing ends the
//! loop. A crate's regex would differ on both of those, and on `\s`.
//!
//! What the matcher is not sure it reads the way V8 does — lookbehind, named
//! groups, octal and `\c` oddities, an escape class at a range's end — is
//! `Unsupported`, and the evaluation goes back to TypeScript. So is a match
//! that runs past a step or depth budget.

use std::cell::Cell;

const MAX_STEPS: u64 = 1_000_000;
/// Nested matcher calls: each costs native stack (the shadow stack, in the
/// artifact), so a pattern that recurses once per character of a long text
/// stops here rather than overflowing it. A repeat of one character (`.*`,
/// `\d+`) loops instead, and costs no depth.
const MAX_DEPTH: u32 = 800;

#[derive(Debug, Clone, PartialEq)]
pub enum RegexError {
    /// `new RegExp` would throw: the TypeScript returns null.
    Syntax,
    /// Not something this matcher reproduces exactly.
    Unsupported(String),
}

#[derive(Debug, Clone)]
enum Node {
    Char(u16),
    Any,
    Class { negated: bool, items: Vec<ClassItem> },
    Start,
    End,
    WordBoundary { negated: bool },
    Group { node: Box<Node>, index: Option<usize> },
    Lookahead { node: Box<Node>, negated: bool },
    Backref(usize),
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Repeat { node: Box<Node>, min: u32, max: Option<u32>, greedy: bool, captures: (usize, usize) },
}

#[derive(Debug, Clone, Copy)]
enum ClassItem {
    Range(u16, u16),
    Digit { negated: bool },
    Word { negated: bool },
    Space { negated: bool },
}

pub struct Regex {
    root: Node,
    groups: usize,
}

type Caps = Vec<Option<(usize, usize)>>;

impl Regex {
    pub fn new(pattern: &str) -> Result<Regex, RegexError> {
        let units: Vec<u16> = pattern.encode_utf16().collect();
        let groups = count_groups(&units)?;
        let mut parser = Parser { p: &units, at: 0, groups, next_group: 1 };
        let root = parser.disjunction()?;
        if parser.at < units.len() {
            // Only an unmatched `)` stops a disjunction early.
            return Err(RegexError::Syntax);
        }
        Ok(Regex { root, groups })
    }

    /// `exec`: the match and its groups (`None` for a group that did not
    /// take part), or `None` when nothing matches.
    pub fn exec(&self, text: &str) -> Result<Option<Vec<Option<Vec<u16>>>>, RegexError> {
        let t: Vec<u16> = text.encode_utf16().collect();
        let run = Run { t: &t, steps: Cell::new(0), depth: Cell::new(0), exceeded: Cell::new(false) };
        for start in 0..=t.len() {
            let mut caps: Caps = vec![None; self.groups + 1];
            let mut found: Option<(usize, Caps)> = None;
            let matched = run.node(&self.root, start, &mut caps, &mut |end, c| {
                found = Some((end, c.clone()));
                true
            });
            if run.exceeded.get() {
                return Err(RegexError::Unsupported("the match ran past its budget".into()));
            }
            if matched {
                let (end, mut caps) = found.expect("a match records its end");
                caps[0] = Some((start, end));
                return Ok(Some(caps.into_iter().map(|c| c.map(|(a, b)| t[a..b].to_vec())).collect()));
            }
        }
        Ok(None)
    }
}

/// Groups nested deeper than this are not parsed: the parser recurses per
/// level, and V8 reads patterns far deeper than a stack here allows (5,000
/// levels compile there), so such a pattern goes back to TypeScript.
const MAX_NESTING: usize = 100;

/// Capturing groups in the whole pattern: a `\N` reads as a backreference
/// when N is at most this, wherever the group is.
fn count_groups(p: &[u16]) -> Result<usize, RegexError> {
    let mut count = 0;
    let mut i = 0;
    let mut in_class = false;
    let mut depth = 0usize;
    while i < p.len() {
        match p[i] {
            0x5C => i += 1,
            0x5B => in_class = true,
            0x5D => in_class = false,
            0x29 if !in_class => depth = depth.saturating_sub(1),
            0x28 if !in_class => {
                depth += 1;
                if depth > MAX_NESTING {
                    return Err(RegexError::Unsupported("groups nested past the parser's depth".into()));
                }
                if p.get(i + 1) == Some(&u16::from(b'?')) {
                    if p.get(i + 2) == Some(&u16::from(b'<')) {
                        return Err(RegexError::Unsupported("named groups and lookbehind".into()));
                    }
                } else {
                    count += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    Ok(count)
}

struct Parser<'a> {
    p: &'a [u16],
    at: usize,
    groups: usize,
    next_group: usize,
}

fn unit(c: u8) -> u16 {
    u16::from(c)
}

impl Parser<'_> {
    fn peek(&self) -> Option<u16> {
        self.p.get(self.at).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(unit(c)) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn disjunction(&mut self) -> Result<Node, RegexError> {
        let mut alternatives = vec![self.alternative()?];
        while self.eat(b'|') {
            alternatives.push(self.alternative()?);
        }
        Ok(if alternatives.len() == 1 { alternatives.pop().expect("one alternative") } else { Node::Alt(alternatives) })
    }

    fn alternative(&mut self) -> Result<Node, RegexError> {
        let mut terms = Vec::new();
        while let Some(c) = self.peek() {
            if c == unit(b'|') || c == unit(b')') {
                break;
            }
            terms.push(self.term()?);
        }
        Ok(Node::Concat(terms))
    }

    fn term(&mut self) -> Result<Node, RegexError> {
        let first_group = self.next_group;
        let c = self.peek().expect("a term starts at a unit");
        let (atom, quantifiable) = match c {
            0x5E => (self.step(Node::Start), false),
            0x24 => (self.step(Node::End), false),
            0x2E => (self.step(Node::Any), true),
            0x28 => self.group()?,
            0x5B => (self.class()?, true),
            0x5C => self.escape()?,
            0x2A | 0x2B | 0x3F => return Err(RegexError::Syntax),
            0x7B if self.quantifier_braces().is_some() => return Err(RegexError::Syntax),
            _ => (self.step(Node::Char(c)), true),
        };
        let Some((min, max)) = self.quantifier()? else { return Ok(atom) };
        if !quantifiable {
            return Err(RegexError::Syntax);
        }
        if matches!(atom, Node::Lookahead { .. }) {
            return Err(RegexError::Unsupported("a quantified lookahead".into()));
        }
        let greedy = !self.eat(b'?');
        Ok(Node::Repeat { node: Box::new(atom), min, max, greedy, captures: (first_group, self.next_group) })
    }

    fn step(&mut self, node: Node) -> Node {
        self.at += 1;
        node
    }

    /// `{n}`, `{n,}` or `{n,m}` at the cursor, without moving it.
    fn quantifier_braces(&self) -> Option<(u32, Option<u32>, usize)> {
        let p = self.p;
        let mut i = self.at + 1;
        let digits = |i: &mut usize| -> Option<u32> {
            let start = *i;
            let mut value: u64 = 0;
            while *i < p.len() && (unit(b'0')..=unit(b'9')).contains(&p[*i]) {
                value = (value * 10 + u64::from(p[*i] - unit(b'0'))).min(u64::from(u32::MAX));
                *i += 1;
            }
            (*i > start).then_some(value as u32)
        };
        let min = digits(&mut i)?;
        let max = if p.get(i) == Some(&unit(b',')) {
            i += 1;
            digits(&mut i)
        } else {
            Some(min)
        };
        let open_ended = max.is_none();
        (p.get(i) == Some(&unit(b'}'))).then_some((min, if open_ended { None } else { max }, i + 1))
    }

    fn quantifier(&mut self) -> Result<Option<(u32, Option<u32>)>, RegexError> {
        let quantifier = match self.peek().map(|c| c as u8) {
            Some(b'*') => Some((0, None)),
            Some(b'+') => Some((1, None)),
            Some(b'?') => Some((0, Some(1))),
            Some(b'{') => match self.quantifier_braces() {
                Some((min, max, end)) => {
                    if max.is_some_and(|max| max < min) {
                        return Err(RegexError::Syntax);
                    }
                    self.at = end - 1;
                    Some((min, max))
                }
                None => None,
            },
            _ => None,
        };
        if quantifier.is_some() {
            self.at += 1;
        }
        Ok(quantifier)
    }

    fn group(&mut self) -> Result<(Node, bool), RegexError> {
        self.at += 1;
        let (index, lookahead) = if self.eat(b'?') {
            if self.eat(b':') {
                (None, None)
            } else if self.eat(b'=') {
                (None, Some(false))
            } else if self.eat(b'!') {
                (None, Some(true))
            } else {
                return Err(RegexError::Syntax);
            }
        } else {
            let index = self.next_group;
            self.next_group += 1;
            (Some(index), None)
        };
        let inner = self.disjunction()?;
        if !self.eat(b')') {
            return Err(RegexError::Syntax);
        }
        Ok(match lookahead {
            Some(negated) => (Node::Lookahead { node: Box::new(inner), negated }, true),
            None => (Node::Group { node: Box::new(inner), index }, true),
        })
    }

    /// `\…` outside a class: an assertion, a class, a backreference or one
    /// character.
    fn escape(&mut self) -> Result<(Node, bool), RegexError> {
        self.at += 1;
        let Some(c) = self.peek() else { return Err(RegexError::Syntax) };
        match c as u8 {
            b'b' if c < 0x80 => Ok((self.step(Node::WordBoundary { negated: false }), false)),
            b'B' if c < 0x80 => Ok((self.step(Node::WordBoundary { negated: true }), false)),
            b'1'..=b'9' if c < 0x80 => {
                let start = self.at;
                while self.peek().is_some_and(|d| (unit(b'0')..=unit(b'9')).contains(&d)) {
                    self.at += 1;
                }
                let n: usize = String::from_utf16_lossy(&self.p[start..self.at]).parse().unwrap_or(usize::MAX);
                if n <= self.groups {
                    Ok((Node::Backref(n), true))
                } else {
                    Err(RegexError::Unsupported("an octal escape".into()))
                }
            }
            _ => {
                let item = self.character_escape(false)?;
                Ok((
                    match item {
                        Escaped::Unit(u) => Node::Char(u),
                        Escaped::Class(item) => Node::Class { negated: false, items: vec![item] },
                    },
                    true,
                ))
            }
        }
    }

    /// The escapes a class and the pattern share; the cursor is past the `\`.
    fn character_escape(&mut self, in_class: bool) -> Result<Escaped, RegexError> {
        let c = self.peek().ok_or(RegexError::Syntax)?;
        self.at += 1;
        if c >= 0x80 {
            return Ok(Escaped::Unit(c));
        }
        let class = |item| Ok(Escaped::Class(item));
        match c as u8 {
            b'd' => class(ClassItem::Digit { negated: false }),
            b'D' => class(ClassItem::Digit { negated: true }),
            b'w' => class(ClassItem::Word { negated: false }),
            b'W' => class(ClassItem::Word { negated: true }),
            b's' => class(ClassItem::Space { negated: false }),
            b'S' => class(ClassItem::Space { negated: true }),
            b'f' => Ok(Escaped::Unit(0x0C)),
            b'n' => Ok(Escaped::Unit(0x0A)),
            b'r' => Ok(Escaped::Unit(0x0D)),
            b't' => Ok(Escaped::Unit(0x09)),
            b'v' => Ok(Escaped::Unit(0x0B)),
            b'b' if in_class => Ok(Escaped::Unit(0x08)),
            b'0' if !self.peek().is_some_and(|d| (unit(b'0')..=unit(b'9')).contains(&d)) => Ok(Escaped::Unit(0)),
            b'0'..=b'9' => Err(RegexError::Unsupported("an octal escape".into())),
            b'x' => self.hex(2),
            b'u' => self.hex(4),
            b'c' | b'k' | b'p' | b'P' => Err(RegexError::Unsupported(format!("\\{}", c as u8 as char))),
            _ => Ok(Escaped::Unit(c)),
        }
    }

    fn hex(&mut self, len: usize) -> Result<Escaped, RegexError> {
        let digits = self.p.get(self.at..self.at + len).ok_or(RegexError::Unsupported("a short hex escape".into()))?;
        let text = String::from_utf16_lossy(digits);
        let value = u16::from_str_radix(&text, 16)
            .ok()
            .filter(|_| text.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or(RegexError::Unsupported("a short hex escape".into()))?;
        self.at += len;
        Ok(Escaped::Unit(value))
    }

    fn class(&mut self) -> Result<Node, RegexError> {
        self.at += 1;
        let negated = self.eat(b'^');
        let mut items = Vec::new();
        loop {
            let Some(c) = self.peek() else { return Err(RegexError::Syntax) };
            if c == unit(b']') {
                self.at += 1;
                return Ok(Node::Class { negated, items });
            }
            let start = self.class_atom()?;
            if self.peek() == Some(unit(b'-')) && self.p.get(self.at + 1).is_some_and(|&n| n != unit(b']')) {
                self.at += 1;
                let end = self.class_atom()?;
                match (start, end) {
                    (Escaped::Unit(a), Escaped::Unit(b)) => {
                        if a > b {
                            return Err(RegexError::Syntax);
                        }
                        items.push(ClassItem::Range(a, b));
                    }
                    _ => return Err(RegexError::Unsupported("a class escape at a range's end".into())),
                }
                continue;
            }
            items.push(match start {
                Escaped::Unit(u) => ClassItem::Range(u, u),
                Escaped::Class(item) => item,
            });
        }
    }

    fn class_atom(&mut self) -> Result<Escaped, RegexError> {
        let c = self.peek().ok_or(RegexError::Syntax)?;
        self.at += 1;
        if c == unit(b'\\') {
            if self.peek().is_none() {
                return Err(RegexError::Syntax);
            }
            if self.peek() == Some(unit(b'-')) {
                self.at += 1;
                return Ok(Escaped::Unit(unit(b'-')));
            }
            return self.character_escape(true);
        }
        Ok(Escaped::Unit(c))
    }
}

enum Escaped {
    Unit(u16),
    Class(ClassItem),
}

fn is_word(u: u16) -> bool {
    matches!(u, 0x30..=0x39 | 0x41..=0x5A | 0x61..=0x7A | 0x5F)
}

fn is_space(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(crate::js::is_js_space)
}

fn is_line_terminator(u: u16) -> bool {
    matches!(u, 0x0A | 0x0D | 0x2028 | 0x2029)
}

impl ClassItem {
    fn matches(self, u: u16) -> bool {
        match self {
            ClassItem::Range(a, b) => (a..=b).contains(&u),
            ClassItem::Digit { negated } => (0x30..=0x39).contains(&u) != negated,
            ClassItem::Word { negated } => is_word(u) != negated,
            ClassItem::Space { negated } => is_space(u) != negated,
        }
    }
}

/// One `exec` attempt. Its counters are cells because every continuation
/// re-enters the matcher while the frame that made it is still running.
struct Run<'a> {
    t: &'a [u16],
    steps: Cell<u64>,
    depth: Cell<u32>,
    exceeded: Cell<bool>,
}

type Continuation<'k> = dyn FnMut(usize, &mut Caps) -> bool + 'k;

impl Run<'_> {
    fn node(&self, node: &Node, pos: usize, caps: &mut Caps, k: &mut Continuation) -> bool {
        self.steps.set(self.steps.get() + 1);
        if self.steps.get() > MAX_STEPS || self.depth.get() > MAX_DEPTH {
            self.exceeded.set(true);
        }
        if self.exceeded.get() {
            return false;
        }
        self.depth.set(self.depth.get() + 1);
        let matched = self.node_inner(node, pos, caps, k);
        self.depth.set(self.depth.get() - 1);
        matched
    }

    fn node_inner(&self, node: &Node, pos: usize, caps: &mut Caps, k: &mut Continuation) -> bool {
        let t = self.t;
        match node {
            Node::Char(c) => t.get(pos) == Some(c) && k(pos + 1, caps),
            Node::Any => t.get(pos).is_some_and(|&u| !is_line_terminator(u)) && k(pos + 1, caps),
            Node::Class { negated, items } => {
                t.get(pos).is_some_and(|&u| items.iter().any(|item| item.matches(u)) != *negated) && k(pos + 1, caps)
            }
            Node::Start => pos == 0 && k(pos, caps),
            Node::End => pos == t.len() && k(pos, caps),
            Node::WordBoundary { negated } => {
                let before = pos > 0 && is_word(t[pos - 1]);
                let after = pos < t.len() && is_word(t[pos]);
                ((before != after) != *negated) && k(pos, caps)
            }
            Node::Group { node, index } => {
                let index = *index;
                self.node(node, pos, caps, &mut |end, c: &mut Caps| {
                    let Some(index) = index else { return k(end, c) };
                    let old = c[index];
                    c[index] = Some((pos, end));
                    if k(end, c) {
                        return true;
                    }
                    c[index] = old;
                    false
                })
            }
            Node::Lookahead { node, negated } => {
                let mut inner = caps.clone();
                let mut seen: Option<Caps> = None;
                let found = self.node(node, pos, &mut inner, &mut |_, c: &mut Caps| {
                    seen = Some(c.clone());
                    true
                });
                if found == *negated {
                    return false;
                }
                match seen.filter(|_| !*negated) {
                    // A positive lookahead's captures stand; nothing
                    // backtracks into it.
                    Some(mut with) => {
                        if k(pos, &mut with) {
                            *caps = with;
                            true
                        } else {
                            false
                        }
                    }
                    None => k(pos, caps),
                }
            }
            Node::Backref(n) => match caps[*n] {
                None => k(pos, caps),
                Some((a, b)) => {
                    let len = b - a;
                    t.get(pos..pos + len).is_some_and(|s| s == &t[a..b]) && k(pos + len, caps)
                }
            },
            Node::Concat(nodes) => self.sequence(nodes, pos, caps, k),
            Node::Alt(alternatives) => {
                for alternative in alternatives {
                    let saved = caps.clone();
                    if self.node(alternative, pos, caps, k) {
                        return true;
                    }
                    *caps = saved;
                }
                false
            }
            Node::Repeat { node, min, max, greedy, captures } => {
                if let Some(unit) = single_unit(node) {
                    return self.repeat_unit(unit, *min, *max, *greedy, pos, caps, k);
                }
                let shape = Repeat { node, greedy: *greedy, captures: *captures };
                self.repeat(&shape, *min, *max, pos, caps, k)
            }
        }
    }

    fn sequence(&self, nodes: &[Node], pos: usize, caps: &mut Caps, k: &mut Continuation) -> bool {
        match nodes.split_first() {
            None => k(pos, caps),
            Some((first, rest)) => self.node(first, pos, caps, &mut |next, c: &mut Caps| self.sequence(rest, next, c, k)),
        }
    }

    /// A repeat of a one-unit matcher, as a loop: it captures nothing and
    /// always consumes, so trying each count in turn is exactly what the
    /// recursive RepeatMatcher would do.
    #[allow(clippy::too_many_arguments)]
    fn repeat_unit(&self, unit: &Node, min: u32, max: Option<u32>, greedy: bool, pos: usize, caps: &mut Caps, k: &mut Continuation) -> bool {
        let limit = max.map_or(usize::MAX, |m| m as usize);
        let mut count = 0;
        while count < limit && pos + count < self.t.len() && unit_matches(unit, self.t[pos + count]) {
            count += 1;
        }
        self.steps.set(self.steps.get() + count as u64);
        if count < min as usize {
            return false;
        }
        let counts: Box<dyn Iterator<Item = usize>> =
            if greedy { Box::new((min as usize..=count).rev()) } else { Box::new(min as usize..=count) };
        for n in counts {
            if self.exceeded.get() {
                return false;
            }
            if k(pos + n, caps) {
                return true;
            }
        }
        false
    }

    /// RepeatMatcher: `min` and `max` are what is left to match.
    fn repeat(&self, shape: &Repeat, min: u32, max: Option<u32>, pos: usize, caps: &mut Caps, k: &mut Continuation) -> bool {
        if max == Some(0) {
            return k(pos, caps);
        }
        if min > 0 {
            return self.iteration(shape, min, max, pos, caps, k);
        }
        if shape.greedy {
            self.iteration(shape, min, max, pos, caps, k) || k(pos, caps)
        } else {
            k(pos, caps) || self.iteration(shape, min, max, pos, caps, k)
        }
    }

    /// One more pass of a repeat, its own captures cleared first.
    fn iteration(&self, shape: &Repeat, min: u32, max: Option<u32>, pos: usize, caps: &mut Caps, k: &mut Continuation) -> bool {
        let saved = caps.clone();
        for slot in &mut caps[shape.captures.0..shape.captures.1] {
            *slot = None;
        }
        let matched = self.node(shape.node, pos, caps, &mut |end, c: &mut Caps| {
            // An iteration that matched nothing, once the minimum is met,
            // ends the loop rather than spinning on it.
            if min == 0 && end == pos {
                return false;
            }
            self.repeat(shape, min.saturating_sub(1), max.map(|m| m - 1), end, c, k)
        });
        if !matched {
            *caps = saved;
        }
        matched
    }
}

/// The node when it matches exactly one code unit.
fn single_unit(node: &Node) -> Option<&Node> {
    matches!(node, Node::Char(_) | Node::Any | Node::Class { .. }).then_some(node)
}

fn unit_matches(node: &Node, u: u16) -> bool {
    match node {
        Node::Char(c) => *c == u,
        Node::Any => !is_line_terminator(u),
        Node::Class { negated, items } => items.iter().any(|item| item.matches(u)) != *negated,
        _ => unreachable!("only one-unit nodes repeat as a loop"),
    }
}

struct Repeat<'n> {
    node: &'n Node,
    greedy: bool,
    captures: (usize, usize),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `exec` gives, as JavaScript prints it: the match and its groups,
    /// `undefined` for one that took no part.
    fn exec(pattern: &str, text: &str) -> Result<Option<Vec<String>>, RegexError> {
        let found = Regex::new(pattern)?.exec(text)?;
        Ok(found.map(|groups| {
            groups
                .into_iter()
                .map(|g| g.map_or_else(|| "undefined".to_string(), |units| String::from_utf16(&units).unwrap()))
                .collect()
        }))
    }

    fn found(pattern: &str, text: &str) -> Vec<String> {
        exec(pattern, text).unwrap().unwrap_or_else(|| panic!("/{pattern}/ matches {text:?}"))
    }

    #[test]
    fn matches_as_javascript_does() {
        // Each expectation is node's `new RegExp(pattern).exec(text)`.
        assert_eq!(found(r"(\d+)-(\d+)", "ref 12-345 x"), ["12-345", "12", "345"]);
        assert_eq!(found(r"a|ab", "ab"), ["a"]);
        assert_eq!(found(r"(a+?)b", "aaab"), ["aaab", "aaa"]);
        assert_eq!(found(r"(?:(a)|b)+", "ab"), ["ab", "undefined"]);
        assert_eq!(found(r"(a*)*", "b"), ["", "undefined"]);
        assert_eq!(found(r"(a*)+", "b"), ["", ""]);
        assert_eq!(found(r"(z)((a+)?(b+)?(c))*", "zaacbbbcac"), ["zaacbbbcac", "z", "ac", "a", "undefined", "c"]);
        assert_eq!(found(r"(?=(a+))a*b\1", "baaabac"), ["aba", "a"]);
        assert_eq!(found(r"(.*?)a(?!(a+)b\2c)\2(.*)", "baaabaac"), ["baaabaac", "ba", "undefined", "abaac"]);
        assert_eq!(found(r"\bfoo\b", "a foo."), ["foo"]);
        assert_eq!(found(r"^\s+x$", "\u{feff}\u{a0} x"), ["\u{feff}\u{a0} x"]);
        assert_eq!(found(r"a.c", "a\u{2028}c abc"), ["abc"]);
        assert_eq!(found(r"[^]", "\n"), ["\n"]);
        assert_eq!(found(r"x{2,3}", "xxxx"), ["xxx"]);
        assert_eq!(found(r"a{,2}", "a{,2}"), ["a{,2}"]);
        assert_eq!(found(r"]}", "]}"), ["]}"]);
        assert_eq!(found(r"[\w-]+", "--ab_9!"), ["--ab_9"]);
        assert_eq!(found(r"[a\-z]+", "a-z"), ["a-z"]);
        assert_eq!(found(r"\x41B\.", "AB."), ["AB."]);
        assert_eq!(found(r"(a)|b", "b"), ["b", "undefined"]);
        assert_eq!(found(r"\1(a)", "aa"), ["a", "a"]);
        // No `u` flag: `.` is one UTF-16 unit, half of an astral character.
        assert_eq!(found_units(".", "😀"), ["[d83d]"]);
        assert!(exec("zz", "abc").unwrap().is_none());
    }

    fn found_units(pattern: &str, text: &str) -> Vec<String> {
        let groups = Regex::new(pattern).unwrap().exec(text).unwrap().unwrap();
        groups.into_iter().map(|g| format!("{:x?}", g.unwrap())).collect()
    }

    #[test]
    fn refuses_what_new_regexp_throws_on() {
        for pattern in ["(", "a)", "[a", "*a", "a**", "+", "a{2}{3}", "x{3,2}", "[z-a]", "(?x)", "^*", "\\", "a|*"] {
            assert_eq!(Regex::new(pattern).err(), Some(RegexError::Syntax), "{pattern}");
        }
    }

    #[test]
    fn leaves_what_it_does_not_reproduce_to_typescript() {
        for pattern in ["(?<y>a)", "(?<=a)b", r"\2(a)", r"\08", r"\c", r"[\d-z]", r"\k<a>", "(?=a)*", r"\p{L}"] {
            assert!(matches!(Regex::new(pattern), Err(RegexError::Unsupported(_))), "{pattern}");
        }
        let nested = format!("{}a{}", "(".repeat(5000), ")".repeat(5000));
        assert!(matches!(Regex::new(&nested), Err(RegexError::Unsupported(_))));
        let long = "a".repeat(5000);
        assert!(matches!(Regex::new("(a|b)*c").unwrap().exec(&long), Err(RegexError::Unsupported(_))));
        // A one-character repeat loops rather than recursing, so a long text
        // stays within the budget.
        let line = format!("Subject: {}", "x".repeat(20_000));
        assert_eq!(found(r"Subject: (.*)$", &line)[1].len(), 20_000);
    }
}
