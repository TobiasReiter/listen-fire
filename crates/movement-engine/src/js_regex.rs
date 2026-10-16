//! `new RegExp(pattern).exec(text)` with no flags, as V8 runs it: a
//! backtracking matcher over UTF-16 code units (no `u` flag, so an astral
//! character is two units), Annex B's lenient syntax, and the spec's
//! repetition rules — every iteration of a quantified group starts with that
//! group's captures cleared, and an iteration that matches nothing ends the
//! loop. A crate's regex would differ on all three, and on `\s`.
//!
//! The whole dialect V8 reads without flags: lookahead and lookbehind (a
//! lookbehind matches right to left, its captures and backreferences
//! included), named groups and `\k<name>`, Annex B's octal escapes, `\c`,
//! identity escapes, quantified lookaheads and class escapes at a range's
//! end. There is no step budget: a pattern V8 runs slowly runs slowly here
//! too. The pattern is compiled to a flat program and run on an explicit
//! backtracking stack, so neither a long text nor deep nesting costs native
//! stack. The one thing handed back (to the TypeScript built-in, so the
//! answer is TypeScript's) is nesting past `MAX_NESTING`: V8 overflows its
//! stack on capturing groups nested somewhere between 8,000 and 10,000
//! deep, at a depth set by the stack it runs on, which this engine cannot
//! know (non-capturing groups it parses far deeper; they are handed back
//! past the same depth all the same).

const MAX_NESTING: usize = 1000;

/// V8's `kMaxCaptures`.
const MAX_CAPTURES: usize = 1 << 16;

#[derive(Debug, Clone, PartialEq)]
pub enum RegexError {
    /// `new RegExp` would throw: the TypeScript returns null.
    Syntax,
    /// Not something this matcher reproduces exactly.
    Unsupported(String),
}

pub struct Regex {
    code: Vec<Inst>,
    classes: Vec<Class>,
    groups: usize,
    repeats: usize,
}

/// One instruction. Jumps are relative to the instruction's own index, so a
/// block of code can be moved or have code inserted before it whole.
#[derive(Debug, Clone, Copy)]
enum Inst {
    Unit { unit: Unit, back: bool },
    Start,
    End,
    WordBoundary { negated: bool },
    /// Go on; on backtracking, resume at `alt`.
    Split { alt: isize },
    Jump(isize),
    Nop,
    GroupOpen(usize),
    GroupClose(usize),
    Backref { group: usize, back: bool },
    /// `\k<name>` until every name is known: the name's place in
    /// `Parser::named_refs`.
    NamedBackref { name: usize, back: bool },
    /// A quantified atom: `RepInit`, `RepLoop`, `RepIter`, the atom, `RepEnd`.
    RepInit(usize),
    RepLoop { reg: usize, min: u32, max: Option<u32>, greedy: bool, exit: isize },
    RepIter { reg: usize, first: usize, last: usize },
    RepEnd { reg: usize, min: u32, back_to: isize },
    /// A quantified one-unit atom, as a loop.
    RepeatUnit { unit: Unit, min: u32, max: Option<u32>, greedy: bool, back: bool },
    LookStart { negated: bool, after: isize },
    LookEnd,
    Match,
}

#[derive(Debug, Clone, Copy)]
enum Unit {
    Char(u16),
    Any,
    Class(usize),
}

#[derive(Debug, Clone)]
struct Class {
    negated: bool,
    items: Vec<ClassItem>,
}

#[derive(Debug, Clone, Copy)]
enum ClassItem {
    Range(u16, u16),
    Digit { negated: bool },
    Word { negated: bool },
    Space { negated: bool },
}

impl Regex {
    pub fn new(pattern: &str) -> Result<Regex, RegexError> {
        let units = crate::js_string::units_vec(pattern);
        let scan = scan_groups(&units)?;
        Parser::new(&units, scan).parse()
    }

    /// `exec`: the match and its groups (`None` for a group that did not
    /// take part), or `None` when nothing matches.
    pub fn exec(&self, text: &str) -> Option<Vec<Option<Vec<u16>>>> {
        let t = crate::js_string::units_vec(text);
        let mut machine = Machine::new(self);
        for start in 0..=t.len() {
            machine.reset();
            if let Some(end) = machine.run(self, &t, start) {
                let mut caps = machine.caps.clone();
                caps[0] = Some((start, end));
                return Some(caps.into_iter().map(|c| c.map(|(a, b)| t[a..b].to_vec())).collect());
            }
        }
        None
    }
}

// ── The pattern's groups, scanned first ──────────────────────────────────────

struct Scan {
    /// Capturing groups in the whole pattern: a `\N` reads as a
    /// backreference when N is at most this, wherever the group is.
    groups: usize,
    /// Whether any is named: then `\k` must name one.
    named: bool,
}

/// V8's `ScanForCaptures`.
fn scan_groups(p: &[u16]) -> Result<Scan, RegexError> {
    let (mut groups, mut named) = (0usize, false);
    let (mut i, mut in_class, mut depth) = (0usize, false, 0usize);
    while i < p.len() {
        match p[i] {
            0x5C => i += 1,
            0x5B => in_class = true,
            0x5D => in_class = false,
            0x29 if !in_class => depth = depth.saturating_sub(1),
            0x28 if !in_class => {
                depth += 1;
                if depth > MAX_NESTING {
                    return Err(RegexError::Unsupported(format!("groups nested past {MAX_NESTING} levels")));
                }
                if p.get(i + 1) == Some(&u16::from(b'?')) {
                    if p.get(i + 2) == Some(&u16::from(b'<')) && !matches!(p.get(i + 3).map(|&c| c as u8), Some(b'=' | b'!')) {
                        groups += 1;
                        named = true;
                    }
                } else {
                    groups += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    if groups >= MAX_CAPTURES {
        return Err(RegexError::Syntax);
    }
    Ok(Scan { groups, named })
}

// ── The parser: one pass, iterative, emitting the program ────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Dir {
    Forward,
    Backward,
}

enum FrameKind {
    Root,
    Capture(usize),
    NonCapture,
    Look { behind: bool, start: usize },
}

struct Frame {
    kind: FrameKind,
    dir: Dir,
    /// Where the group's code starts: a quantifier inserts its loop here.
    open_at: usize,
    /// The groups the frame holds start at this number.
    first_group: usize,
    /// The current alternative's `Split`, patched when the next one starts.
    split: usize,
    /// Each earlier alternative's jump to the end.
    jumps: Vec<usize>,
    /// Where each term of the current alternative starts: a lookbehind's
    /// terms run right to left, so their blocks are reversed when it ends.
    terms: Vec<usize>,
}

/// What the parser just read, for a quantifier after it.
enum Atom {
    /// Nothing to repeat: an assertion, or nothing at all.
    None,
    /// A lookbehind: a quantifier after it is a syntax error.
    Lookbehind,
    /// Code from `start`, holding groups `first..last`.
    Code { start: usize, first: usize, last: usize },
}

struct Parser<'a> {
    p: &'a [u16],
    at: usize,
    scan: Scan,
    code: Vec<Inst>,
    classes: Vec<Class>,
    next_group: usize,
    repeats: usize,
    names: Vec<(Vec<u32>, usize)>,
    /// `\k<name>` references, resolved once every name is known.
    named_refs: Vec<Vec<u32>>,
    frames: Vec<Frame>,
}

fn unit(c: u8) -> u16 {
    u16::from(c)
}

fn is_digit(u: u16) -> bool {
    (unit(b'0')..=unit(b'9')).contains(&u)
}

fn is_octal(u: u16) -> bool {
    (unit(b'0')..=unit(b'7')).contains(&u)
}

impl<'a> Parser<'a> {
    fn new(p: &'a [u16], scan: Scan) -> Parser<'a> {
        Parser {
            p,
            at: 0,
            scan,
            code: Vec::new(),
            classes: Vec::new(),
            next_group: 1,
            repeats: 0,
            names: Vec::new(),
            named_refs: Vec::new(),
            frames: Vec::new(),
        }
    }

    fn peek(&self) -> Option<u16> {
        self.p.get(self.at).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<u16> {
        self.p.get(self.at + offset).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(unit(c)) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn dir(&self) -> Dir {
        self.frames.last().expect("the root frame is open").dir
    }

    fn back(&self) -> bool {
        self.dir() == Dir::Backward
    }

    fn emit(&mut self, inst: Inst) -> usize {
        self.code.push(inst);
        self.code.len() - 1
    }

    /// A frame opens; `first_group` is the first group it holds (a capture's
    /// own, which a quantifier on it clears too).
    fn open(&mut self, kind: FrameKind, dir: Dir, open_at: usize, first_group: usize) {
        let split = self.emit(Inst::Split { alt: 0 });
        self.frames.push(Frame { kind, dir, open_at, first_group, split, jumps: Vec::new(), terms: Vec::new() });
    }

    fn parse(mut self) -> Result<Regex, RegexError> {
        self.open(FrameKind::Root, Dir::Forward, 0, 1);
        while let Some(c) = self.peek() {
            match c as u8 {
                b'|' if c < 0x80 => {
                    self.at += 1;
                    self.end_alternative();
                    let jump = self.emit(Inst::Jump(0));
                    let next = self.code.len();
                    let frame = self.frames.last_mut().expect("a frame is open");
                    frame.jumps.push(jump);
                    let split = frame.split;
                    self.code[split] = Inst::Split { alt: (next - split) as isize };
                    let split = self.emit(Inst::Split { alt: 0 });
                    let frame = self.frames.last_mut().expect("a frame is open");
                    frame.split = split;
                    frame.terms.clear();
                }
                b')' if c < 0x80 => {
                    if self.frames.len() == 1 {
                        // Unmatched `)`.
                        return Err(RegexError::Syntax);
                    }
                    self.at += 1;
                    let atom = self.close();
                    self.quantified(atom)?;
                }
                _ => {
                    let start = self.code.len();
                    self.frames.last_mut().expect("a frame is open").terms.push(start);
                    let atom = self.term()?;
                    if let Some(atom) = atom {
                        self.quantified(atom)?;
                    }
                }
            }
        }
        if self.frames.len() > 1 {
            // Unterminated group.
            return Err(RegexError::Syntax);
        }
        self.close();
        for at in 0..self.code.len() {
            if let Inst::NamedBackref { name, back } = self.code[at] {
                let Some(&(_, group)) = self.names.iter().find(|(n, _)| *n == self.named_refs[name]) else { return Err(RegexError::Syntax) };
                self.code[at] = Inst::Backref { group, back };
            }
        }
        Ok(Regex { code: self.code, classes: self.classes, groups: self.next_group - 1, repeats: self.repeats })
    }

    /// The current alternative ends: a lookbehind's terms reversed.
    fn end_alternative(&mut self) {
        let frame = self.frames.last().expect("a frame is open");
        if frame.dir == Dir::Forward || frame.terms.len() < 2 {
            return;
        }
        let first = frame.terms[0];
        let mut bounds = frame.terms.clone();
        bounds.push(self.code.len());
        let blocks: Vec<Vec<Inst>> = bounds.windows(2).map(|w| self.code[w[0]..w[1]].to_vec()).collect();
        self.code.truncate(first);
        for block in blocks.into_iter().rev() {
            self.code.extend(block);
        }
    }

    /// `)` (or the pattern's end): the frame's alternatives joined, its
    /// closing code emitted, and the group as an atom.
    fn close(&mut self) -> Atom {
        self.end_alternative();
        let frame = self.frames.pop().expect("a frame is open");
        self.code[frame.split] = Inst::Nop;
        let end = self.code.len();
        for jump in &frame.jumps {
            self.code[*jump] = Inst::Jump((end - jump) as isize);
        }
        let atom = Atom::Code { start: frame.open_at, first: frame.first_group, last: self.next_group };
        match frame.kind {
            FrameKind::Root => {
                self.emit(Inst::Match);
                Atom::None
            }
            FrameKind::Capture(index) => {
                self.emit(Inst::GroupClose(index));
                atom
            }
            FrameKind::NonCapture => atom,
            FrameKind::Look { behind, start } => {
                self.emit(Inst::LookEnd);
                let after = self.code.len();
                let Inst::LookStart { negated, .. } = self.code[start] else { unreachable!("a look opens with its start") };
                self.code[start] = Inst::LookStart { negated, after: (after - start) as isize };
                if behind { Atom::Lookbehind } else { atom }
            }
        }
    }

    /// One term other than a group's end or an alternative: an atom to
    /// quantify, or `None` once a group has opened (its quantifier follows
    /// its `)`).
    fn term(&mut self) -> Result<Option<Atom>, RegexError> {
        let start = self.code.len();
        let first = self.next_group;
        let code = |p: &Parser| Atom::Code { start, first, last: p.next_group };
        let c = self.peek().expect("a term starts at a unit");
        let back = self.back();
        let atom = match c {
            0x5E => {
                self.at += 1;
                self.emit(Inst::Start);
                Atom::None
            }
            0x24 => {
                self.at += 1;
                self.emit(Inst::End);
                Atom::None
            }
            0x2E => {
                self.at += 1;
                self.emit(Inst::Unit { unit: Unit::Any, back });
                code(self)
            }
            0x28 => {
                self.group(start)?;
                return Ok(None);
            }
            0x5B => {
                let class = self.class()?;
                self.emit(Inst::Unit { unit: Unit::Class(class), back });
                code(self)
            }
            0x5C => self.escape(start)?,
            // Nothing to repeat.
            0x2A | 0x2B | 0x3F => return Err(RegexError::Syntax),
            0x7B if self.quantifier_braces().is_some() => return Err(RegexError::Syntax),
            _ => {
                self.at += 1;
                self.emit(Inst::Unit { unit: Unit::Char(c), back });
                code(self)
            }
        };
        Ok(Some(atom))
    }

    fn group(&mut self, open_at: usize) -> Result<(), RegexError> {
        self.at += 1;
        let dir = self.dir();
        let first = self.next_group;
        if !self.eat(b'?') {
            let index = self.capture();
            self.emit(Inst::GroupOpen(index));
            self.open(FrameKind::Capture(index), dir, open_at, first);
            return Ok(());
        }
        let look = |negated: bool| Inst::LookStart { negated, after: 0 };
        match self.peek().map(|c| c as u8) {
            Some(b':') => {
                self.at += 1;
                self.open(FrameKind::NonCapture, dir, open_at, first);
            }
            Some(b'=' | b'!') => {
                let negated = self.peek() == Some(unit(b'!'));
                self.at += 1;
                let start = self.emit(look(negated));
                self.open(FrameKind::Look { behind: false, start }, Dir::Forward, open_at, first);
            }
            Some(b'<') if matches!(self.peek_at(1).map(|c| c as u8), Some(b'=' | b'!')) => {
                let negated = self.peek_at(1) == Some(unit(b'!'));
                self.at += 2;
                let start = self.emit(look(negated));
                self.open(FrameKind::Look { behind: true, start }, Dir::Backward, open_at, first);
            }
            Some(b'<') => {
                self.at += 1;
                let name = self.group_name()?;
                if self.names.iter().any(|(n, _)| *n == name) {
                    return Err(RegexError::Syntax);
                }
                let index = self.capture();
                self.names.push((name, index));
                self.emit(Inst::GroupOpen(index));
                self.open(FrameKind::Capture(index), dir, open_at, first);
            }
            _ => return Err(RegexError::Syntax),
        }
        Ok(())
    }

    fn capture(&mut self) -> usize {
        self.next_group += 1;
        self.next_group - 1
    }

    /// `RegExpIdentifierName` and its `>`; the cursor is past the `<`.
    fn group_name(&mut self) -> Result<Vec<u32>, RegexError> {
        let mut name = Vec::new();
        loop {
            let Some(c) = self.peek() else { return Err(RegexError::Syntax) };
            if c == unit(b'>') && !name.is_empty() {
                self.at += 1;
                return Ok(name);
            }
            let code = if c == unit(b'\\') {
                self.at += 1;
                if !self.eat(b'u') {
                    return Err(RegexError::Syntax);
                }
                self.name_escape()?
            } else {
                self.at += 1;
                match (c, self.peek()) {
                    (0xD800..=0xDBFF, Some(low @ 0xDC00..=0xDFFF)) => {
                        self.at += 1;
                        0x10000 + ((u32::from(c) - 0xD800) << 10) + (u32::from(low) - 0xDC00)
                    }
                    _ => u32::from(c),
                }
            };
            let fits = match char::from_u32(code) {
                Some(ch) if name.is_empty() => ch == '$' || ch == '_' || ch.is_ascii_alphabetic(),
                Some(ch) => ch == '$' || ch == '_' || ch.is_ascii_alphanumeric(),
                None => false,
            };
            if !fits {
                return Err(RegexError::Syntax);
            }
            name.push(code);
        }
    }

    /// A name's `\u` escape: `\uXXXX` (a surrogate pair of two read as one)
    /// or `\u{X…}`; the cursor is past the `u`.
    fn name_escape(&mut self) -> Result<u32, RegexError> {
        if self.eat(b'{') {
            let start = self.at;
            while self.peek().is_some_and(|c| c != unit(b'}')) {
                self.at += 1;
            }
            let digits = String::from_utf16_lossy(&self.p[start..self.at]);
            if !self.eat(b'}') || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(RegexError::Syntax);
            }
            return u32::from_str_radix(&digits, 16).ok().filter(|&v| v <= 0x10FFFF).ok_or(RegexError::Syntax);
        }
        let lead = self.hex4().ok_or(RegexError::Syntax)?;
        if (0xD800..=0xDBFF).contains(&lead)
            && self.peek() == Some(unit(b'\\'))
            && self.peek_at(1) == Some(unit(b'u'))
        {
            let saved = self.at;
            self.at += 2;
            match self.hex4() {
                Some(trail @ 0xDC00..=0xDFFF) => return Ok(0x10000 + ((u32::from(lead) - 0xD800) << 10) + (u32::from(trail) - 0xDC00)),
                _ => self.at = saved,
            }
        }
        Ok(u32::from(lead))
    }

    /// Four hex digits at the cursor, consumed; nothing consumed otherwise.
    fn hex4(&mut self) -> Option<u16> {
        self.hex(4)
    }

    fn hex(&mut self, len: usize) -> Option<u16> {
        let digits = self.p.get(self.at..self.at + len)?;
        if !digits.iter().all(|&d| d < 0x80 && (d as u8).is_ascii_hexdigit()) {
            return None;
        }
        let value = u16::from_str_radix(&String::from_utf16_lossy(digits), 16).ok()?;
        self.at += len;
        Some(value)
    }

    /// `\…` outside a class: an assertion, a class, a backreference or one
    /// character.
    fn escape(&mut self, start: usize) -> Result<Atom, RegexError> {
        let first = self.next_group;
        let back = self.back();
        let Some(c) = self.peek_at(1) else { return Err(RegexError::Syntax) };
        let one = |p: &mut Parser, unit: Unit| {
            let back = p.back();
            p.emit(Inst::Unit { unit, back });
            Atom::Code { start, first, last: p.next_group }
        };
        if c >= 0x80 {
            self.at += 2;
            return Ok(one(self, Unit::Char(c)));
        }
        match c as u8 {
            b'b' | b'B' => {
                self.at += 2;
                self.emit(Inst::WordBoundary { negated: c == unit(b'B') });
                Ok(Atom::None)
            }
            b'1'..=b'9' => {
                let digits_at = self.at + 1;
                let mut end = digits_at;
                let mut value: usize = 0;
                while self.p.get(end).copied().is_some_and(is_digit) {
                    value = value.saturating_mul(10).saturating_add(usize::from(self.p[end] - unit(b'0')));
                    end += 1;
                }
                if value <= self.scan.groups {
                    self.at = end;
                    self.emit(Inst::Backref { group: value, back });
                    return Ok(Atom::Code { start, first, last: self.next_group });
                }
                if c == unit(b'8') || c == unit(b'9') {
                    self.at += 2;
                    return Ok(one(self, Unit::Char(c)));
                }
                self.at += 1;
                let octal = self.octal();
                Ok(one(self, Unit::Char(octal)))
            }
            b'0' => {
                self.at += 1;
                let octal = self.octal();
                Ok(one(self, Unit::Char(octal)))
            }
            b'k' if self.scan.named => {
                self.at += 2;
                if !self.eat(b'<') {
                    return Err(RegexError::Syntax);
                }
                let name = self.group_name()?;
                self.emit(Inst::NamedBackref { name: self.named_refs.len(), back });
                self.named_refs.push(name);
                Ok(Atom::Code { start, first, last: self.next_group })
            }
            b'c' => {
                let letter = self.peek_at(2).filter(|&l| l < 0x80 && (l as u8).is_ascii_alphabetic());
                match letter {
                    Some(letter) => {
                        self.at += 3;
                        Ok(one(self, Unit::Char(letter & 0x1F)))
                    }
                    None => {
                        // Annex B: the backslash is a character, and the `c`
                        // is read next as itself.
                        self.at += 1;
                        Ok(one(self, Unit::Char(unit(b'\\'))))
                    }
                }
            }
            _ => {
                self.at += 1;
                match self.character_escape(false)? {
                    Escaped::Unit(u) => Ok(one(self, Unit::Char(u))),
                    Escaped::Class(item) => {
                        let class = self.add_class(Class { negated: false, items: vec![item] });
                        Ok(one(self, Unit::Class(class)))
                    }
                }
            }
        }
    }

    /// V8's `ParseOctalLiteral`: up to three octal digits below 256; the
    /// cursor is at the first digit.
    fn octal(&mut self) -> u16 {
        let mut value = self.p[self.at] - unit(b'0');
        self.at += 1;
        if self.peek().is_some_and(is_octal) {
            value = value * 8 + (self.p[self.at] - unit(b'0'));
            self.at += 1;
            if value < 32 && self.peek().is_some_and(is_octal) {
                value = value * 8 + (self.p[self.at] - unit(b'0'));
                self.at += 1;
            }
        }
        value
    }

    /// The escapes a class and the pattern share; the cursor is at the
    /// character after the `\`.
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
            b'0'..=b'7' if in_class => {
                self.at -= 1;
                Ok(Escaped::Unit(self.octal()))
            }
            b'x' => Ok(Escaped::Unit(self.hex(2).unwrap_or(unit(b'x')))),
            b'u' => Ok(Escaped::Unit(self.hex4().unwrap_or(unit(b'u')))),
            // `\k` in a class is an identity escape only where no group is
            // named.
            b'k' if in_class && self.scan.named => Err(RegexError::Syntax),
            _ => Ok(Escaped::Unit(c)),
        }
    }

    fn add_class(&mut self, class: Class) -> usize {
        self.classes.push(class);
        self.classes.len() - 1
    }

    fn class(&mut self) -> Result<usize, RegexError> {
        self.at += 1;
        let negated = self.eat(b'^');
        let mut items = Vec::new();
        loop {
            let Some(c) = self.peek() else { return Err(RegexError::Syntax) };
            if c == unit(b']') {
                self.at += 1;
                return Ok(self.add_class(Class { negated, items }));
            }
            let start = self.class_atom()?;
            if self.peek() == Some(unit(b'-')) && self.peek_at(1).is_some_and(|n| n != unit(b']')) {
                self.at += 1;
                let end = self.class_atom()?;
                match (start, end) {
                    (Escaped::Unit(a), Escaped::Unit(b)) => {
                        if a > b {
                            return Err(RegexError::Syntax);
                        }
                        items.push(ClassItem::Range(a, b));
                    }
                    // Annex B: a class escape at either end is no range; both
                    // sides and the `-` are members.
                    (a, b) => {
                        for side in [a, b] {
                            items.push(side.into_item());
                        }
                        items.push(ClassItem::Range(unit(b'-'), unit(b'-')));
                    }
                }
                continue;
            }
            items.push(start.into_item());
        }
    }

    fn class_atom(&mut self) -> Result<Escaped, RegexError> {
        let c = self.peek().ok_or(RegexError::Syntax)?;
        self.at += 1;
        if c != unit(b'\\') {
            return Ok(Escaped::Unit(c));
        }
        let Some(next) = self.peek() else { return Err(RegexError::Syntax) };
        if next == unit(b'c') {
            // Annex B's ClassControlLetter: a letter, a digit or `_`; else
            // the backslash is a member and the `c` is read next.
            return Ok(match self.peek_at(1).filter(|&l| l < 0x80 && ((l as u8).is_ascii_alphanumeric() || l == unit(b'_'))) {
                Some(letter) => {
                    self.at += 2;
                    Escaped::Unit(letter & 0x1F)
                }
                None => Escaped::Unit(unit(b'\\')),
            });
        }
        self.character_escape(true)
    }

    /// `{n}`, `{n,}` or `{n,m}` at the cursor, without moving it.
    fn quantifier_braces(&self) -> Option<(u32, Option<u32>, usize)> {
        let p = self.p;
        let mut i = self.at + 1;
        let digits = |i: &mut usize| -> Option<u32> {
            let start = *i;
            let mut value: u64 = 0;
            while *i < p.len() && is_digit(p[*i]) {
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

    /// A quantifier after `atom`, if one follows, wrapped round its code.
    fn quantified(&mut self, atom: Atom) -> Result<(), RegexError> {
        let Some((min, max)) = self.quantifier()? else { return Ok(()) };
        let greedy = !self.eat(b'?');
        let (start, first, last) = match atom {
            Atom::None | Atom::Lookbehind => return Err(RegexError::Syntax),
            Atom::Code { start, first, last } => (start, first, last),
        };
        if start + 1 == self.code.len()
            && let Inst::Unit { unit, back } = self.code[start]
        {
            self.code[start] = Inst::RepeatUnit { unit, min, max, greedy, back };
            return Ok(());
        }
        let reg = self.repeats;
        self.repeats += 1;
        // Nothing outside the atom points into it or past it yet, and its
        // own jumps are relative: inserting before it moves it whole.
        self.code.splice(start..start, [Inst::RepInit(reg), Inst::Nop, Inst::RepIter { reg, first, last }]);
        let end = self.emit(Inst::Nop);
        let looping = start + 1;
        self.code[looping] = Inst::RepLoop { reg, min, max, greedy, exit: (end + 1 - looping) as isize };
        self.code[end] = Inst::RepEnd { reg, min, back_to: looping as isize - end as isize };
        Ok(())
    }
}

enum Escaped {
    Unit(u16),
    Class(ClassItem),
}

impl Escaped {
    fn into_item(self) -> ClassItem {
        match self {
            Escaped::Unit(u) => ClassItem::Range(u, u),
            Escaped::Class(item) => item,
        }
    }
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

// ── The machine ───────────────────────────────────────────────────────────────

/// A state change, undone when backtracking passes back over it.
#[derive(Clone, Copy)]
enum Undo {
    Cap(usize, Option<(usize, usize)>),
    GroupStart(usize, usize),
    Count(usize, u32),
    RepStart(usize, usize),
}

/// A choice to come back to, with the trail's length when it was made.
#[derive(Clone, Copy)]
enum Choice {
    At { pc: usize, pos: usize, trail: usize },
    /// A one-unit repeat's next count to try: down from its greedy most,
    /// or up from its lazy least.
    Units { pc: usize, base: usize, next: u32, max: Option<u32>, unit: Unit, greedy: bool, back: bool, min: u32, trail: usize },
    /// A lookaround's body running: reached again, the body failed.
    Look { negated: bool, pos: usize, after: usize, trail: usize },
}

struct Machine {
    caps: Vec<Option<(usize, usize)>>,
    group_start: Vec<usize>,
    count: Vec<u32>,
    rep_start: Vec<usize>,
    trail: Vec<Undo>,
    choices: Vec<Choice>,
}

fn offset(pc: usize, by: isize) -> usize {
    pc.checked_add_signed(by).expect("a jump lands inside the program")
}

impl Machine {
    fn new(regex: &Regex) -> Machine {
        Machine {
            caps: vec![None; regex.groups + 1],
            group_start: vec![0; regex.groups + 1],
            count: vec![0; regex.repeats],
            rep_start: vec![0; regex.repeats],
            trail: Vec::new(),
            choices: Vec::new(),
        }
    }

    fn reset(&mut self) {
        self.caps.fill(None);
        self.trail.clear();
        self.choices.clear();
    }

    fn unwind(&mut self, to: usize) {
        while self.trail.len() > to {
            match self.trail.pop().expect("the trail is longer than its mark") {
                Undo::Cap(k, old) => self.caps[k] = old,
                Undo::GroupStart(k, old) => self.group_start[k] = old,
                Undo::Count(r, old) => self.count[r] = old,
                Undo::RepStart(r, old) => self.rep_start[r] = old,
            }
        }
    }

    fn set_cap(&mut self, k: usize, value: Option<(usize, usize)>) {
        self.trail.push(Undo::Cap(k, self.caps[k]));
        self.caps[k] = value;
    }

    /// The match from `start`: where it ends.
    fn run(&mut self, regex: &Regex, t: &[u16], start: usize) -> Option<usize> {
        let (mut pc, mut pos) = (0usize, start);
        loop {
            let ok = match regex.code[pc] {
                Inst::Unit { unit, back } => match step(regex, t, pos, unit, back) {
                    Some(next) => {
                        pos = next;
                        pc += 1;
                        true
                    }
                    None => false,
                },
                Inst::Start => {
                    pc += 1;
                    pos == 0
                }
                Inst::End => {
                    pc += 1;
                    pos == t.len()
                }
                Inst::WordBoundary { negated } => {
                    let before = pos > 0 && is_word(t[pos - 1]);
                    let after = pos < t.len() && is_word(t[pos]);
                    pc += 1;
                    (before != after) != negated
                }
                Inst::Split { alt } => {
                    self.choices.push(Choice::At { pc: offset(pc, alt), pos, trail: self.trail.len() });
                    pc += 1;
                    true
                }
                Inst::Jump(by) => {
                    pc = offset(pc, by);
                    true
                }
                Inst::Nop => {
                    pc += 1;
                    true
                }
                Inst::GroupOpen(k) => {
                    self.trail.push(Undo::GroupStart(k, self.group_start[k]));
                    self.group_start[k] = pos;
                    pc += 1;
                    true
                }
                Inst::GroupClose(k) => {
                    let from = self.group_start[k];
                    self.set_cap(k, Some((from.min(pos), from.max(pos))));
                    pc += 1;
                    true
                }
                Inst::Backref { group, back } => {
                    pc += 1;
                    match self.caps[group] {
                        None => true,
                        Some((a, b)) => {
                            let len = b - a;
                            let span = if back { pos.checked_sub(len).map(|s| s..pos) } else { Some(pos..pos + len) };
                            match span.filter(|s| t.get(s.clone()).is_some_and(|s| s == &t[a..b])) {
                                Some(s) => {
                                    pos = if back { s.start } else { s.end };
                                    true
                                }
                                None => false,
                            }
                        }
                    }
                }
                Inst::RepInit(reg) => {
                    self.trail.push(Undo::Count(reg, self.count[reg]));
                    self.count[reg] = 0;
                    pc += 1;
                    true
                }
                Inst::RepLoop { reg, min, max, greedy, exit } => {
                    let n = self.count[reg];
                    if n < min {
                        pc += 1;
                    } else if max.is_some_and(|max| n >= max) {
                        pc = offset(pc, exit);
                    } else if greedy {
                        self.choices.push(Choice::At { pc: offset(pc, exit), pos, trail: self.trail.len() });
                        pc += 1;
                    } else {
                        self.choices.push(Choice::At { pc: pc + 1, pos, trail: self.trail.len() });
                        pc = offset(pc, exit);
                    }
                    true
                }
                Inst::RepIter { reg, first, last } => {
                    self.trail.push(Undo::RepStart(reg, self.rep_start[reg]));
                    self.rep_start[reg] = pos;
                    for k in first..last {
                        if self.caps[k].is_some() {
                            self.set_cap(k, None);
                        }
                    }
                    pc += 1;
                    true
                }
                Inst::RepEnd { reg, min, back_to } => {
                    let n = self.count[reg];
                    // An iteration past the minimum that matched nothing
                    // ends the loop by failing.
                    if n >= min && pos == self.rep_start[reg] {
                        false
                    } else {
                        self.trail.push(Undo::Count(reg, n));
                        self.count[reg] = n.saturating_add(1);
                        pc = offset(pc, back_to);
                        true
                    }
                }
                Inst::RepeatUnit { unit, min, max, greedy, back } => {
                    let base = pos;
                    let at = |k: u32| if back { base - k as usize } else { base + k as usize };
                    let fits = |k: u32| (!back || k as usize <= base) && step(regex, t, at(k), unit, back).is_some();
                    let mut taken = 0u32;
                    let most = if greedy { max.unwrap_or(u32::MAX) } else { min };
                    while taken < most && fits(taken) {
                        taken += 1;
                    }
                    if taken < min {
                        false
                    } else {
                        let trail = self.trail.len();
                        if greedy && taken > min {
                            self.choices.push(Choice::Units { pc: pc + 1, base, next: taken - 1, max, unit, greedy, back, min, trail });
                        } else if !greedy && max.is_none_or(|max| taken < max) {
                            self.choices.push(Choice::Units { pc: pc + 1, base, next: taken + 1, max, unit, greedy, back, min, trail });
                        }
                        pos = at(taken);
                        pc += 1;
                        true
                    }
                }
                Inst::LookStart { negated, after } => {
                    self.choices.push(Choice::Look { negated, pos, after: offset(pc, after), trail: self.trail.len() });
                    pc += 1;
                    true
                }
                Inst::LookEnd => {
                    let at = self.choices.iter().rposition(|c| matches!(c, Choice::Look { .. })).expect("a look's body ends inside it");
                    let Choice::Look { negated, pos: from, after, trail } = self.choices[at] else { unreachable!("found by its kind") };
                    // Nothing backtracks into a lookaround once it matched.
                    self.choices.truncate(at);
                    if negated {
                        self.unwind(trail);
                        false
                    } else {
                        pos = from;
                        pc = after;
                        true
                    }
                }
                Inst::Match => return Some(pos),
                Inst::NamedBackref { .. } => unreachable!("every name is resolved when the pattern is read"),
            };
            if ok {
                continue;
            }
            // Backtrack to the latest choice.
            loop {
                let choice = self.choices.pop()?;
                match choice {
                    Choice::At { pc: to, pos: at, trail } => {
                        self.unwind(trail);
                        pc = to;
                        pos = at;
                        break;
                    }
                    Choice::Units { pc: to, base, next, max, unit, greedy, back, min, trail } => {
                        self.unwind(trail);
                        let at = |k: u32| if back { base - k as usize } else { base + k as usize };
                        if greedy {
                            if next > min {
                                self.choices.push(Choice::Units { pc: to, base, next: next - 1, max, unit, greedy, back, min, trail });
                            }
                            pc = to;
                            pos = at(next);
                            break;
                        }
                        // Lazy: one more unit, if it fits.
                        let from = at(next - 1);
                        if step(regex, t, from, unit, back).is_some() {
                            if max.is_none_or(|max| next < max) {
                                self.choices.push(Choice::Units { pc: to, base, next: next + 1, max, unit, greedy, back, min, trail });
                            }
                            pc = to;
                            pos = at(next);
                            break;
                        }
                    }
                    Choice::Look { negated, pos: from, after, trail } => {
                        if negated {
                            self.unwind(trail);
                            pc = after;
                            pos = from;
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// One unit matched at `pos` going forward, or before it going back: the
/// position after it.
fn step(regex: &Regex, t: &[u16], pos: usize, unit: Unit, back: bool) -> Option<usize> {
    let (at, next) = if back { (pos.checked_sub(1)?, pos - 1) } else { (pos, pos + 1) };
    let u = *t.get(at)?;
    let matched = match unit {
        Unit::Char(c) => c == u,
        Unit::Any => !is_line_terminator(u),
        Unit::Class(i) => {
            let class = &regex.classes[i];
            class.items.iter().any(|item| item.matches(u)) != class.negated
        }
    };
    matched.then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `exec` gives, as JavaScript prints it: the match and its groups,
    /// `undefined` for one that took no part.
    fn exec(pattern: &str, text: &str) -> Result<Option<Vec<String>>, RegexError> {
        let found = Regex::new(pattern)?.exec(text);
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

    #[test]
    fn reads_the_rest_of_the_dialect_as_v8_does() {
        // Lookbehind, right to left, its captures and backreferences too.
        assert_eq!(found(r"(?<=(a))b", "ab"), ["b", "a"]);
        assert_eq!(found(r"(?<=\1(a))b", "aab"), ["b", "a"]);
        assert_eq!(found(r"(?<=(\d+)(\d+))$", "1053"), ["", "1", "053"]);
        assert!(exec(r"(?<!a)b", "ab").unwrap().is_none());
        assert_eq!(found(r"(?<=a{2})b", "aab"), ["b"]);
        // Named groups.
        assert_eq!(found(r"(?<y>\d{4})-\k<y>", "2026-2026"), ["2026-2026", "2026"]);
        assert_eq!(found(r"(?<A>.)\k<A>", "xx"), ["xx", "x"]);
        // Version 5 spells a group name in ASCII (`$`, `_`, letters, digits).
        assert!(matches!(exec(r"(?<𝒜>.)", "x"), Err(RegexError::Syntax)));
        assert!(matches!(exec(r"(?<é>.)", "x"), Err(RegexError::Syntax)));
        assert_eq!(found(r"(?<_a1$>.)", "x"), ["x", "x"]);
        assert_eq!(found(r"\k<a>", "k<a>"), ["k<a>"]);
        // Annex B's escapes.
        assert_eq!(found(r"\8", "8"), ["8"]);
        assert_eq!(found(r"\18", "\u{1}8"), ["\u{1}8"]);
        assert_eq!(found(r"\377", "ÿ"), ["ÿ"]);
        assert_eq!(found(r"\400", " 0"), [" 0"]);
        assert_eq!(found(r"[\18]", "8"), ["8"]);
        assert_eq!(found(r"\c1", "\\c1"), ["\\c1"]);
        assert_eq!(found(r"\cJ", "\n"), ["\n"]);
        assert_eq!(found(r"[\c1]", "\u{11}"), ["\u{11}"]);
        assert_eq!(found(r"[\c*]", "\\"), ["\\"]);
        assert_eq!(found(r"[\c]", "c"), ["c"]);
        assert_eq!(found(r"\x4", "x4"), ["x4"]);
        assert_eq!(found(r"\u12", "u12"), ["u12"]);
        assert_eq!(found(r"\p{L}", "p{L}"), ["p{L}"]);
        assert_eq!(found(r"[\d-z]", "-"), ["-"]);
        assert_eq!(found(r"[a-\d]", "-"), ["-"]);
        // Quantified lookaheads.
        assert_eq!(found(r"(?=a)*b", "b"), ["b"]);
        assert_eq!(found(r"(?=a){2}a", "a"), ["a"]);
    }

    fn found_units(pattern: &str, text: &str) -> Vec<String> {
        let groups = Regex::new(pattern).unwrap().exec(text).unwrap();
        groups.into_iter().map(|g| format!("{:x?}", g.unwrap())).collect()
    }

    #[test]
    fn refuses_what_new_regexp_throws_on() {
        for pattern in [
            "(", "a)", "[a", "*a", "a**", "+", "a{2}{3}", "x{3,2}", "[z-a]", "(?x)", "^*", "\\", "a|*", "(?<=a)*", "\\b+",
            "(?<a>x)[\\k]", "(?<a>x)\\k<b>", "(?<a>x)|(?<a>y)", "(?<a>x)\\k", "(?<1>x)", "(?<>x)",
        ] {
            assert_eq!(Regex::new(pattern).err(), Some(RegexError::Syntax), "{pattern}");
        }
    }

    #[test]
    fn neither_a_long_text_nor_deep_nesting_costs_native_stack() {
        let long = "a".repeat(5_000);
        assert!(Regex::new("(a|b)*c").unwrap().exec(&long).is_none());
        assert_eq!(found("(a|b)*", &long)[0].len(), 5_000);
        let nested = format!("{}a{}", "(".repeat(MAX_NESTING), ")".repeat(MAX_NESTING));
        assert_eq!(found(&nested, "xa").len(), MAX_NESTING + 1);
        let deeper = format!("{}a{}", "(".repeat(MAX_NESTING + 1), ")".repeat(MAX_NESTING + 1));
        assert!(matches!(Regex::new(&deeper), Err(RegexError::Unsupported(_))));
        let line = format!("Subject: {}", "x".repeat(20_000));
        assert_eq!(found(r"Subject: (.*)$", &line)[1].len(), 20_000);
    }
}
