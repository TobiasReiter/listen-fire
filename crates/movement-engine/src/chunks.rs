//! `CHUNKS(text, { size | entities, overlap })`: a long text cut into
//! pieces (movement-lang expression/chunk.ts), and the entities estimate
//! the second mode walks with (expression/density.ts).
//!
//! The size mode is exact: every count, cut and search is over UTF-16 code
//! units, as the TypeScript's `length`, `slice` and `indexOf` are. The
//! entities mode reads `\p{Lu}`, `\p{L}` and `\p{N}` from this engine's own
//! Unicode tables (Henry's ruling, 2026-10-12: no regex dialect is grown for
//! it): `\p{L}`/`\p{N}` is the table Node's own answers wrote
//! (crate::letter_number), `\p{Lu}` is Rust's `Uppercase` narrowed to
//! letters, so on text with uncommon letters a piece boundary may move by a
//! line (README, Known divergences). The link and list-item patterns are
//! ASCII and are matched exactly.

use crate::js::Js;

/// How a cut is made (`ChunkSpec`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Spec {
    Size { size: usize, overlap: usize },
    Entities { entities: usize, overlap: usize },
}

impl Spec {
    pub fn mode(&self) -> &'static str {
        match self {
            Spec::Size { .. } => "size",
            Spec::Entities { .. } => "entities",
        }
    }
}

/// `readChunkSpec`: the options as a run worked them out, or the sentence
/// the run fails with.
pub fn read_spec(size: &Js, entities: &Js, overlap: &Js) -> Result<Spec, String> {
    let by_size = !matches!(size, Js::Undefined);
    let by_entities = !matches!(entities, Js::Undefined);
    if by_size && by_entities {
        return Err(format!(
            "CHUNKS is given both a size ({}) and an expected {} records — they are two ways of saying how big a piece is, so a cut is made by one of them",
            describe(size),
            describe(entities)
        ));
    }
    if !by_size && !by_entities {
        return Err("CHUNKS needs a size in characters or a number of expected records, and this run worked out neither".into());
    }
    let overlap_value = if overlap.is_nullish() { Some(0.0) } else { count_of(overlap) };
    let overlap_value = match overlap_value {
        Some(n) if n >= 0.0 => n,
        _ => return Err(format!("CHUNKS overlaps pieces by a number of characters, and this run asked for {}", describe(overlap))),
    };
    if by_entities {
        return match count_of(entities) {
            Some(n) if n >= 1.0 => Ok(Spec::Entities { entities: as_count(n), overlap: as_count(overlap_value) }),
            _ => Err(format!("CHUNKS needs to expect at least 1 record in a piece, and this run asked for {}", describe(entities))),
        };
    }
    let size_value = match count_of(size) {
        Some(n) if n >= 1.0 => n,
        _ => return Err(format!("CHUNKS needs a size of at least 1 character, and this run asked for {}", describe(size))),
    };
    if overlap_value >= size_value {
        return Err(format!(
            "CHUNKS cannot overlap pieces by {} characters when each piece is at most {} — the overlap has to be smaller than the size, or a piece would never get past the one before it",
            crate::js::number_to_string(overlap_value),
            crate::js::number_to_string(size_value)
        ));
    }
    Ok(Spec::Size { size: as_count(size_value), overlap: as_count(overlap_value) })
}

/// `countOf`: a finite number, rounded down.
fn count_of(value: &Js) -> Option<f64> {
    match value {
        Js::Number(n) if n.is_finite() => Some(n.floor()),
        _ => None,
    }
}

/// A count past what a text can hold cuts as the longest one does.
fn as_count(n: f64) -> usize {
    if n >= usize::MAX as f64 { usize::MAX } else { n as usize }
}

fn describe(value: &Js) -> String {
    match value {
        v if v.is_nullish() => "nothing".into(),
        Js::Number(n) => crate::js::number_to_string(*n),
        Js::String(text) => format!("the text \"{}\"", text.as_form()),
        other => format!("a {}", other.type_of()),
    }
}

const CUT_WINDOW: f64 = 0.1;
const NL: u16 = b'\n' as u16;

/// `chunkText`: the pieces, in order, as code-unit ranges of `text`.
pub fn chunk(text: &[u16], spec: Spec) -> Vec<std::ops::Range<usize>> {
    if is_blank(text) {
        return Vec::new();
    }
    match spec {
        Spec::Size { size, overlap } => by_size(text, size, overlap),
        Spec::Entities { entities, overlap } => by_entities(text, entities, overlap),
    }
}

/// `text.trim().length === 0`.
fn is_blank(text: &[u16]) -> bool {
    crate::js::trim(&crate::js_string::text_of_units(text)).is_empty()
}

fn by_size(text: &[u16], size: usize, overlap: usize) -> Vec<std::ops::Range<usize>> {
    if text.len() <= size {
        return vec![std::ops::Range { start: 0, end: text.len() }];
    }
    let mut pieces = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let ceiling = start.saturating_add(size);
        if ceiling >= text.len() {
            pieces.push(start..text.len());
            break;
        }
        let cut = whole_code_point(text, cut_before(text, start, ceiling, size));
        pieces.push(start..cut);
        start = whole_code_point(text, cut.saturating_sub(overlap)).max(start + 1);
    }
    pieces
}

/// `cutBefore`: the last break within the final tenth before the ceiling, a
/// blank line over a line break over a space, else the ceiling.
fn cut_before(text: &[u16], start: usize, ceiling: usize, size: usize) -> usize {
    let back = ((size as f64 * CUT_WINDOW).floor() as usize).max(1);
    let window_start = (start + 1).max(ceiling.saturating_sub(back));
    let window = &text[window_start.min(ceiling)..ceiling];
    if let Some(end) = last_paragraph_end(window) {
        return window_start + end;
    }
    if let Some(line) = window.iter().rposition(|&u| u == NL) {
        return window_start + line + 1;
    }
    if let Some(space) = window.iter().rposition(|&u| u == b' ' as u16) {
        return window_start + space + 1;
    }
    ceiling
}

/// The end of the last `/\n[ \t]*\n/g` match.
fn last_paragraph_end(window: &[u16]) -> Option<usize> {
    let mut end = None;
    let mut at = 0;
    while at < window.len() {
        if window[at] == NL {
            let mut next = at + 1;
            while next < window.len() && (window[next] == b' ' as u16 || window[next] == b'\t' as u16) {
                next += 1;
            }
            if next < window.len() && window[next] == NL {
                end = Some(next + 1);
                at = next + 1;
                continue;
            }
        }
        at += 1;
    }
    end
}

/// `wholeCodePoint`: off the seam of a surrogate pair.
fn whole_code_point(text: &[u16], offset: usize) -> usize {
    if offset == 0 || offset >= text.len() {
        return offset;
    }
    let before = text[offset - 1];
    let at = text[offset];
    if (0xd800..=0xdbff).contains(&before) && (0xdc00..=0xdfff).contains(&at) { offset - 1 } else { offset }
}

struct Line {
    start: usize,
    end: usize,
    entities: usize,
    blank: bool,
}

fn counted_lines(text: &[u16]) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = text[start..].iter().position(|&u| u == NL).map_or(text.len(), |at| start + at + 1);
        let line = &text[start..end];
        lines.push(Line { start, end, entities: entities_in_line(line), blank: is_blank(line) });
        start = end;
    }
    lines
}

fn by_entities(text: &[u16], entities: usize, overlap: usize) -> Vec<std::ops::Range<usize>> {
    let lines = counted_lines(text);
    let mut pieces = Vec::new();
    let mut first = 0;
    while first < lines.len() {
        let mut running = 0usize;
        let mut last: Option<usize> = None;
        for (i, line) in lines.iter().enumerate().skip(first) {
            let with_line = running.saturating_add(line.entities);
            if last.is_some() && with_line > entities {
                break;
            }
            running = with_line;
            last = Some(i);
        }
        let last = last.expect("the first line always goes in");
        if last + 1 >= lines.len() {
            pieces.push(lines[first].start..text.len());
            break;
        }
        let (end, cut_line) = cut_back_to_paragraph(&lines, first, last);
        pieces.push(lines[first].start..end);
        let resume = line_holding(&lines, end.saturating_sub(overlap)).min(cut_line + 1);
        first = resume.max(first + 1);
    }
    pieces
}

fn line_holding(lines: &[Line], offset: usize) -> usize {
    lines.iter().position(|line| line.end > offset).unwrap_or(lines.len())
}

fn cut_back_to_paragraph(lines: &[Line], first: usize, last: usize) -> (usize, usize) {
    let end = lines[last].end;
    let window = (((end - lines[first].start) as f64 * CUT_WINDOW).floor() as usize).max(1);
    let mut i = last;
    while i > first + 1 {
        i -= 1;
        if end - lines[i].end > window {
            break;
        }
        if lines[i].blank {
            return (lines[i].end, i);
        }
    }
    (end, last)
}

// ── The entities estimate (density.ts) ────────────────────────────────────

/// `estimateEntities`: the sum over the text's lines (split on `\n`).
pub fn entities(text: &[u16]) -> usize {
    text.split(|&u| u == NL).map(entities_in_line).sum()
}

/// `estimateEntitiesInLine`.
pub fn entities_in_line(line: &[u16]) -> usize {
    let links = distinct_links(line);
    let item = usize::from(is_list_item(line));
    if links > 0 || item > 0 {
        return links.max(item);
    }
    proper_nouns(line)
}

/// `PROSE_ENTITIES_PER_HUNDRED_CHARS`.
const PROSE_ENTITIES_PER_HUNDRED_CHARS: f64 = 0.5;

fn proper_nouns(line: &[u16]) -> usize {
    let runs = distinct_proper_noun_runs(line);
    if runs == 0 {
        return 0;
    }
    let room = ((line.len() as f64 / 100.0) * PROSE_ENTITIES_PER_HUNDRED_CHARS).ceil() as usize;
    runs.min(room.max(1))
}

/// `LIST_ITEM`: `^[ \t]*(?:\[[^\]]+\]|[•·*\-–—][ \t]|\d+[.)][ \t])`.
fn is_list_item(line: &[u16]) -> bool {
    let mut at = 0;
    while at < line.len() && (line[at] == b' ' as u16 || line[at] == b'\t' as u16) {
        at += 1;
    }
    let rest = &line[at..];
    let space = |u: Option<&u16>| matches!(u, Some(&c) if c == b' ' as u16 || c == b'\t' as u16);
    match rest.first() {
        Some(&open) if open == b'[' as u16 => rest.iter().skip(1).position(|&u| u == b']' as u16).is_some_and(|close| close > 0),
        Some(&mark) if [0x2022, 0x00b7, b'*' as u16, b'-' as u16, 0x2013, 0x2014].contains(&mark) => space(rest.get(1)),
        Some(&d) if is_digit(d) => {
            let digits = rest.iter().take_while(|&&u| is_digit(u)).count();
            matches!(rest.get(digits), Some(&p) if p == b'.' as u16 || p == b')' as u16) && space(rest.get(digits + 1))
        }
        _ => false,
    }
}

fn is_digit(u: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&u)
}

/// `PROPER_NOUN_RUN` (`/u`): an uppercase letter and the word it starts,
/// then one or more runs of spaces or tabs each followed by another such
/// word; counted distinct by `toLowerCase()`.
fn distinct_proper_noun_runs(line: &[u16]) -> usize {
    let chars: Vec<(usize, char)> = code_points(line);
    let word_char = |c: char| crate::letter_number::is_letter_or_number(c) || matches!(c, '\'' | '\u{2019}' | '&' | '.' | '-');
    let upper = |c: char| c.is_uppercase() && crate::letter_number::is_letter_or_number(c) && !c.is_numeric();
    let mut seen: Vec<String> = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        if !upper(chars[at].1) {
            at += 1;
            continue;
        }
        let word_end = |from: usize| {
            let mut end = from + 1;
            while end < chars.len() && word_char(chars[end].1) {
                end += 1;
            }
            end
        };
        let mut end = word_end(at);
        let mut words = 1;
        loop {
            let mut gap = end;
            while gap < chars.len() && matches!(chars[gap].1, ' ' | '\t') {
                gap += 1;
            }
            if gap == end || gap >= chars.len() || !upper(chars[gap].1) {
                break;
            }
            end = word_end(gap);
            words += 1;
        }
        if words < 2 {
            at += 1;
            continue;
        }
        let from = chars[at].0;
        let to = chars.get(end).map_or(line.len(), |c| c.0);
        let run = crate::js::to_lower_case(&crate::js_string::text_of_units(&line[from..to]));
        if !seen.contains(&run) {
            seen.push(run);
        }
        at = end;
    }
    seen.len()
}

/// The code points of `units` with where each starts; a lone surrogate is
/// a code point of its own, as `/u` reads it.
fn code_points(units: &[u16]) -> Vec<(usize, char)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < units.len() {
        let u = units[at];
        if (0xd800..=0xdbff).contains(&u) && at + 1 < units.len() && (0xdc00..=0xdfff).contains(&units[at + 1]) {
            let c = 0x10000 + ((u32::from(u) - 0xd800) << 10) + (u32::from(units[at + 1]) - 0xdc00);
            out.push((at, char::from_u32(c).unwrap_or('\u{fffd}')));
            at += 2;
        } else {
            out.push((at, char::from_u32(u32::from(u)).unwrap_or('\u{fffd}')));
            at += 1;
        }
    }
    out
}

/// The top-level suffixes a bare domain must end in (`LINK`), in the
/// alternation's order.
const SUFFIXES: [&str; 24] = [
    "com", "org", "net", "io", "ai", "co", "dev", "app", "uk", "de", "fr", "nl", "es", "it", "se", "eu", "us", "vc", "tech", "cloud", "me", "xyz", "info", "biz",
];

/// `LINK` (`/gi`), each match normalised (`normalizeLink`), counted distinct.
fn distinct_links(line: &[u16]) -> usize {
    let mut seen: Vec<String> = Vec::new();
    let mut at = 0;
    while at < line.len() {
        match link_at(line, at) {
            Some(end) => {
                let link = normalize_link(&crate::js_string::text_of_units(&line[at..end]));
                if !seen.contains(&link) {
                    seen.push(link);
                }
                at = end;
            }
            None => at += 1,
        }
    }
    seen.len()
}

fn lower(u: u16) -> u16 {
    if (b'A' as u16..=b'Z' as u16).contains(&u) { u + 32 } else { u }
}

/// `[^\s<>()[\]"']`: JavaScript's `\s` is its whitespace set.
fn link_char(u: u16) -> bool {
    !(is_js_space(u) || b"<>()[]\"'".iter().any(|&c| u == c as u16))
}

fn is_js_space(u: u16) -> bool {
    matches!(u, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn is_word(u: u16) -> bool {
    (b'a' as u16..=b'z' as u16).contains(&u) || (b'A' as u16..=b'Z' as u16).contains(&u) || is_digit(u) || u == b'_' as u16
}

/// The end of a `LINK` match starting at `at`, its first alternative (a
/// scheme) tried first.
fn link_at(line: &[u16], at: usize) -> Option<usize> {
    let starts = |offset: usize, text: &str| text.bytes().enumerate().all(|(i, b)| line.get(offset + i).is_some_and(|&u| lower(u) == b as u16));
    for scheme in ["https://", "http://"] {
        if starts(at, scheme) {
            let from = at + scheme.len();
            let end = from + line[from..].iter().take_while(|&&u| link_char(u)).count();
            if end > from {
                return Some(end);
            }
        }
    }
    // `(?:label\.)+` greedily, then backed off one label at a time until a
    // suffix ends on a word boundary.
    let label = |from: usize| -> Option<usize> {
        let alnum = |u: u16| (b'a' as u16..=b'z' as u16).contains(&lower(u)) || is_digit(u);
        let run = line[from..].iter().take_while(|&&u| alnum(u) || u == b'-' as u16).count();
        let end = from + run;
        (run > 0 && alnum(line[from]) && alnum(line[end - 1]) && line.get(end) == Some(&(b'.' as u16))).then_some(end + 1)
    };
    let mut ends = Vec::new();
    let mut next = at;
    while let Some(end) = label(next) {
        ends.push(end);
        next = end;
    }
    for &after in ends.iter().rev() {
        for suffix in SUFFIXES {
            let end = after + suffix.len();
            if starts(after, suffix) && line.get(end).is_none_or(|&u| !is_word(u)) {
                // `(?:\/[^\s<>()[\]"']*)?`.
                if line.get(end) == Some(&(b'/' as u16)) {
                    return Some(end + 1 + line[end + 1..].iter().take_while(|&&u| link_char(u)).count());
                }
                return Some(end);
            }
        }
    }
    None
}

/// `normalizeLink`.
fn normalize_link(link: &str) -> String {
    let lowered = crate::js::to_lower_case(link);
    let mut text = lowered.as_str();
    for prefix in ["https://", "http://"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest;
            break;
        }
    }
    text = text.strip_prefix("www.").unwrap_or(text);
    text.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']']).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn pieces(text: &str, spec: Spec) -> Vec<String> {
        let units = units(text);
        chunk(&units, spec).into_iter().map(|r| String::from_utf16_lossy(&units[r])).collect()
    }

    #[test]
    fn the_size_mode_cuts_back_to_the_biggest_pause_in_the_last_tenth() {
        let text = "aaaaaaaaa bbbbbbbbb\n\ncccccccccc dddddddd";
        assert_eq!(pieces(text, Spec::Size { size: 20, overlap: 0 }), ["aaaaaaaaa bbbbbbbbb\n", "\ncccccccccc dddddddd"]);
        assert_eq!(pieces("   ", Spec::Size { size: 2, overlap: 0 }), Vec::<String>::new());
        assert_eq!(pieces("abcdef", Spec::Size { size: 4, overlap: 2 }), ["abcd", "cdef"]);
    }

    #[test]
    fn the_entities_estimate_counts_links_items_and_proper_nouns() {
        assert_eq!(entities_in_line(&units("See https://Acme.com/x and acme.com and www.beta.io.")), 3);
        assert_eq!(entities_in_line(&units("- one item")), 1);
        assert_eq!(entities_in_line(&units("12) numbered")), 1);
        assert_eq!(entities_in_line(&units("[src] tagged")), 1);
        assert_eq!(entities_in_line(&units("Jane Doe met Example Ventures")), 1);
        assert_eq!(entities_in_line(&units("acme.community is no link")), 0);
        assert_eq!(entities_in_line(&units("acme.co.uk")), 1);
    }
}
