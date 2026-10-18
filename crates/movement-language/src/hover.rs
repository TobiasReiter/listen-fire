//! Hover: the name under the cursor, its type as the check settled it, one
//! line about it, and its page in the versioned docs.

use movement_checker::scope::SymbolKind;
use movement_checker::types::position::describe_position;

use crate::text::{Pos, Range, Text, inside_backticks, is_word_char, loc_of, trailing_word, utf16_len};
use crate::docs::{FIELD, WALK, builtin_page, page_of};
use crate::{Service, builtins, docs_url, walk};

#[derive(Debug, Clone)]
pub struct Hover {
    /// Markdown.
    pub contents: String,
    pub range: Range,
}

/// The name under a position, and what is written just before it.
pub struct Word {
    pub name: String,
    pub range: Range,
    /// Read off a receiver: `x.name`, ``x.`name` ``.
    pub after_dot: bool,
    /// The document's text before the `.`, or before the hop's `-[`.
    pub receiver: String,
    /// The edge of a hop: `-[name`, `-[a:name`.
    pub in_hop: bool,
}

pub fn word_at(text: &Text<'_>, pos: Pos) -> Option<Word> {
    let line = text.line(pos.line);
    let before = text.line_before(pos);
    let after = text.line_after(pos);
    let (name, outer_start, end) = if inside_backticks(before) {
        let open = before.rfind('`')?;
        let close = after.find('`')?;
        (format!("{}{}", &before[open + 1..], &after[..close]), open, before.len() + close + 1)
    } else {
        let left = trailing_word(before);
        let right: &str = &after[..after.find(|c: char| !is_word_char(c)).unwrap_or(after.len())];
        if left.is_empty() && right.is_empty() {
            // On a backticked name's opening backtick.
            let rest = after.strip_prefix('`')?;
            let close = rest.find('`')?;
            (rest[..close].to_string(), before.len(), before.len() + close + 2)
        } else {
            (format!("{left}{right}"), before.len() - left.len(), before.len() + right.len())
        }
    };
    let prefix = &line[..outer_start];
    let above = text.before(Pos { line: pos.line, character: 0 });
    let after_dot = prefix.ends_with('.');
    let hop_head = prefix.strip_suffix(':').map(|p| p.strip_suffix(trailing_word(p)).unwrap_or(p)).unwrap_or(prefix);
    let in_hop = !after_dot && hop_head.ends_with("-[") && (prefix.ends_with(':') || prefix.ends_with("-["));
    let receiver = if after_dot {
        format!("{above}{}", &prefix[..prefix.len() - 1])
    } else if in_hop {
        format!("{above}{}", &hop_head[..hop_head.len() - 2])
    } else {
        String::new()
    };
    let start = Pos { line: pos.line, character: utf16_len(&line[..outer_start]) as u32 };
    let end = Pos { line: pos.line, character: utf16_len(&line[..end.min(line.len())]) as u32 };
    Some(Word { name, range: Range { start, end }, after_dot, receiver, in_hop })
}

fn card(header: &str, line: &str, (page, anchor): (&str, &str)) -> String {
    format!("```movement\n{header}\n```\n{line}\n\n[Docs]({})", docs_url(page, anchor))
}

pub fn builtin_card(name: &str) -> Option<String> {
    let builtin = builtins::by_name(name)?;
    let (page, anchor) = builtin_page(builtin.name);
    Some(card(&builtin.signature(), &builtin.doc(), (page, &anchor)))
}

pub fn hover(service: &Service, source: &str, pos: Pos) -> Option<Hover> {
    let text = Text::new(source);
    let word = word_at(&text, pos)?;
    let at = loc_of(pos);
    let version = service.language_version;
    let finish = |contents: String| Some(Hover { contents, range: word.range });
    if word.after_dot {
        let receiver_name = walk::trailing_name(word.receiver.trim_end()).unwrap_or_default();
        let analyzed = service.analyze(source, Some(pos.line));
        let resolves = analyzed.as_ref().is_some_and(|a| a.analysis.resolve(at, &receiver_name).is_some());
        if !resolves && builtins::namespaces().contains(&receiver_name.as_str()) {
            return finish(builtin_card(&format!("{receiver_name}.{}", word.name))?);
        }
        let analysis = &analyzed?.analysis;
        if let Some(position) = walk::receiver(analysis, &word.receiver, at, version) {
            let ty = walk::field_type(&position, &word.name).unwrap_or_else(|| "not a field it has".into());
            return finish(card(&format!("{}: {ty}", crate::text::written_name(&word.name)), &format!("A field of {}.", describe_position(&position)), FIELD));
        }
        // A package's member, bound as `web.fetchUrl`.
        let id = analysis.resolve(at, &format!("{receiver_name}.{}", word.name))?;
        let symbol = analysis.symbol(id);
        return finish(card(&format!("{}.{}", receiver_name, word.name), symbol.kind.describe(), page_of(symbol.kind)));
    }
    let analyzed = service.analyze(source, Some(pos.line));
    if word.in_hop {
        let analysis = &analyzed?.analysis;
        let position = walk::receiver(analysis, &word.receiver, at, version)?;
        let (_, landing) = walk::edges(&position, version).into_iter().find(|(edge, _)| *edge == word.name)?;
        return finish(card(&format!("-[:{}]->", crate::text::written_name(&word.name)), &format!("An edge of {}, landing on {landing}.", describe_position(&position)), WALK));
    }
    if let Some(analyzed) = &analyzed
        && let Some(id) = analyzed.analysis.resolve(at, &word.name)
    {
        let analysis = &analyzed.analysis;
        let symbol = analysis.symbol(id);
        let ty = analysis.type_text(id);
        let header = match symbol.kind {
            SymbolKind::Movement | SymbolKind::Shape | SymbolKind::Type if !symbol.unit => {
                let declared = text.slice(&movement_parser::ast::Span { start: symbol.span.start, end: symbol.span.end });
                let first = declared.lines().next().unwrap_or(&symbol.name);
                first.split('{').next().unwrap_or(first).trim().to_string()
            }
            _ => match &ty {
                Some(ty) => format!("{}: {ty}", symbol.name),
                None => symbol.name.clone(),
            },
        };
        let mut line = symbol.kind.describe().to_string();
        line[..1].make_ascii_uppercase();
        if symbol.unit {
            line = format!("{line}: one of the run host's units, in scope with no import");
        }
        if let (Some(ty), SymbolKind::Movement) = (&ty, symbol.kind) {
            line = format!("{line} — {ty}");
        }
        if let Some(imported) = analysis.imported(&word.name) {
            line = format!("{line}, from \"{}\"", imported.file);
        }
        return finish(card(&header, &format!("{line}."), page_of(symbol.kind)));
    }
    finish(builtin_card(&word.name)?)
}
