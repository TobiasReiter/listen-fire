//! The extraction keyword (`x = extract from […] { … }`) under language
//! version 5: refused as MOV_EXTRACT_KEYWORD_RETIRED, with the rewrite to the
//! extraction call where it is mechanical — extract_keyword_retired.ts, the
//! same message and the same fix. The rewrite declares the tree as a node
//! shape and extracts it with `extractOne`; it is never `safe` (the record may
//! be absent where the keyword's result never was, an untyped field becomes
//! `<text>`, the model is asked through the call's prompt). A `through […]`
//! stage has no rewrite.

use movement_parser::ast::{ExprSlot, ExtractExpression, ExtractNode, ExtractStage, Loc, ShapeNode, Span};
use serde_json::json;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::Diagnostic;
use crate::scope::{Resolution, ScopeId};

const ROOT_WORDS: &str = "\"the relevant information in the content\"";

const RETIRED: &str = "the extraction keyword ('extract from […] { … }') is retired — an extraction is the call over a declared node shape: 'extract(content, Shape)' for each record the content holds, 'extractOne(content, Shape)' for the one it describes";

const THROUGH: &str = "No rewrite keeps a 'through […]' stage's meaning: it hands each record's plugin answers to a further extraction of that record, merged into it, where a plugin called as a function hands back a value of its own. Rewrite it by hand: declare the shape, extract it, map over the records calling each plugin, extractOne over the content plus what the plugin returned, and merge the two with a spread";

impl Checker<'_> {
    /// `reportExtractKeywordRetired`.
    pub(crate) fn report_extract_keyword_retired(&mut self, extract: &ExtractExpression, scope: ScopeId, binding: Option<&str>, statement: Span) {
        let at = extract.span.start;
        let top_level = self.file_statement_spans.iter().find(|span| !before(at, span.start) && !before(span.end, at)).map_or(statement.start, |span| span.start);
        let resolve = |type_: &str| match self.scopes.resolve(scope, type_) {
            Resolution::Found(id) => self.declared_extract_shape(id).map(|declared| declared.declaration.root),
            _ => None,
        };
        let (message, fix) = match blocker_of(&extract.stages, &resolve) {
            Some(blocker) => (format!("{RETIRED}. {blocker}"), None),
            None => {
                let name = shape_name(binding, &self.file_names);
                let built = rewrite(extract, &name, binding, statement.start, top_level, &resolve);
                self.file_names.insert(name);
                built
            }
        };
        let mut diagnostic = Diagnostic::error(codes::EXTRACT_KEYWORD_RETIRED, message, extract.span);
        diagnostic.fix = fix;
        self.push(diagnostic);
    }
}

fn before(a: Loc, b: Loc) -> bool {
    a.line < b.line || (a.line == b.line && a.col < b.col)
}

fn rewrite(
    extract: &ExtractExpression,
    name: &str,
    binding: Option<&str>,
    statement: Loc,
    top_level: Loc,
    resolve: &dyn Fn(&str) -> Option<ShapeNode>,
) -> (String, Option<serde_json::Value>) {
    // A description that interpolates reads the scope it is written in, so the
    // declaration stays in the body there; any other is hoisted to file level.
    let in_body = interpolates(&extract.stages);
    let indent = if in_body { " ".repeat(statement.col.saturating_sub(1)) } else { String::new() };
    let mut lines = vec![format!("{indent}node {name}: {ROOT_WORDS} {{")];
    lines.extend(stage_lines(&extract.stages[0], &format!("{indent}  "), resolve));
    lines.push(format!("{indent}}}"));
    let at = Loc { line: if in_body { statement.line } else { top_level.line }, col: 1 };
    let tier = extract.tier.as_ref().map(|tier| serde_json::to_string(tier).unwrap_or_default());
    let settings = tier.as_ref().map_or(String::new(), |tier| format!(", {{ tier: {tier} }}"));
    let content: Vec<&str> = extract.from.iter().map(|slot| slot.raw.trim()).collect();
    let call = format!("extractOne([{}], {name}{settings})", content.join(", "));
    let short = format!("extractOne(content, {name}{settings})");
    let bound = match binding {
        Some(binding) => format!("'{binding} = {short}'"),
        None => format!("'{short}'"),
    };
    let message = format!(
        "{RETIRED}. The fix declares this tree as 'node {name}' and writes {bound}: the one record the keyword's result was, its fields read off it and its nodes walked from it as before. Review it before applying: the record may be absent where the keyword's result never was (a field read off it then needs a fallback), an untyped field becomes <text>, and the model is asked through the call's prompt"
    );
    let declaration = format!("{}\n{}", lines.join("\n"), if in_body { "" } else { "\n" });
    let fix = json!({ "edits": [
        { "span": Span { start: at, end: at }, "text": declaration },
        { "span": extract.span, "text": call },
    ] });
    (message, Some(fix))
}

/// Why no rewrite keeps this tree's meaning, if one is why.
fn blocker_of(stages: &[ExtractStage], resolve: &dyn Fn(&str) -> Option<ShapeNode>) -> Option<String> {
    if stages.len() != 1 || stages.iter().any(|stage| stage.through.is_some()) {
        return Some(THROUGH.to_string());
    }
    stages[0].children.iter().find_map(|child| match child {
        ExtractNode::Declared(node) => {
            if !node.stages.is_empty() {
                return Some(THROUGH.to_string());
            }
            let type_ = &node.declared.type_;
            match resolve(type_) {
                None => Some(format!("The node '{}' names <{type_}>, which is no node declaration in scope: declare the shape by hand", node.name)),
                Some(shape) if shape_interpolates(&shape) => Some(format!(
                    "The node '{}' takes its fields from <{type_}>, whose words interpolate in the file that declared them, so copying them into a new declaration could change what they say: declare the shape by hand",
                    node.name
                )),
                Some(_) => None,
            }
        }
        ExtractNode::Inline(node) => blocker_of(&node.stages, resolve),
    })
}

/// `x` → `XShape`, `found_cos` → `FoundCosShape`; a name already taken gets
/// the next number (`XShape2`).
pub fn shape_name(binding: Option<&str>, taken: &std::collections::HashSet<String>) -> String {
    let written = binding.unwrap_or("extracted");
    let base: String = written
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            let first = chars.next().map(|c| c.to_ascii_uppercase()).into_iter();
            first.chain(chars).collect::<String>()
        })
        .collect::<String>()
        + "Shape";
    let first = if base.starts_with(|c: char| c.is_ascii_alphabetic()) { base } else { format!("X{base}") };
    if !taken.contains(&first) {
        return first;
    }
    (2..).map(|n| format!("{first}{n}")).find(|name| !taken.contains(name)).unwrap_or(first)
}

fn interpolates(stages: &[ExtractStage]) -> bool {
    stages.iter().any(|stage| {
        stage.fields.iter().any(|field| holds_interpolation(Some(&field.description)))
            || stage.children.iter().any(|child| match child {
                ExtractNode::Inline(node) => holds_interpolation(Some(&node.description)) || interpolates(&node.stages),
                ExtractNode::Declared(node) => holds_interpolation(node.description.as_ref()) || interpolates(&node.stages),
            })
    })
}

fn shape_interpolates(shape: &ShapeNode) -> bool {
    holds_interpolation(shape.description.as_ref())
        || shape.fields.iter().any(|field| holds_interpolation(field.description.as_ref()))
        || shape.children.iter().any(shape_interpolates)
}

fn holds_interpolation(slot: Option<&ExprSlot>) -> bool {
    slot.is_some_and(|slot| slot.raw.contains("${"))
}

fn stage_lines(stage: &ExtractStage, indent: &str, resolve: &dyn Fn(&str) -> Option<ShapeNode>) -> Vec<String> {
    let mut lines: Vec<String> = stage
        .fields
        .iter()
        .map(|field| format!("{indent}{}: {} {}", spelled(&field.name), type_marker(field.type_.as_deref().unwrap_or("text"), field.nullable == Some(true)), field.description.raw.trim()))
        .collect();
    for child in &stage.children {
        match child {
            ExtractNode::Declared(node) => {
                let Some(shape) = resolve(&node.declared.type_) else { continue };
                let description = node.description.clone().or(shape.description.clone());
                lines.extend(shape_lines(&ShapeNode { name: node.name.clone(), description, ..shape }, indent));
            }
            ExtractNode::Inline(node) => {
                lines.push(format!("{indent}node {}: {} {{", spelled(&node.name), node.description.raw.trim()));
                lines.extend(stage_lines(&node.stages[0], &format!("{indent}  "), resolve));
                lines.push(format!("{indent}}}"));
            }
        }
    }
    lines
}

fn shape_lines(node: &ShapeNode, indent: &str) -> Vec<String> {
    let words = node.description.as_ref().map_or(String::new(), |words| format!(": {}", words.raw.trim()));
    let order = node.sequenced.map_or(String::new(), |sequenced| format!(" order by {}", sequenced.word()));
    let mut lines = vec![format!("{indent}node {}{words} {{", spelled(&node.name))];
    for field in &node.fields {
        let described = field.description.as_ref().map_or(String::new(), |words| format!(" {}", words.raw.trim()));
        lines.push(format!("{indent}  {}: {}{described}", spelled(&field.name), type_marker(&field.type_, field.nullable == Some(true))));
    }
    for child in &node.children {
        lines.extend(shape_lines(child, &format!("{indent}  ")));
    }
    lines.push(format!("{indent}}}{order}"));
    lines
}

/// `<text>`, `<text | null>`; a borrowed `crm.companies.stage` in its
/// surface spelling, `` <crm-[:companies]->.`stage`> ``.
fn type_marker(type_: &str, nullable: bool) -> String {
    let segments: Vec<&str> = type_.split('.').collect();
    let borrowed = segments.len() == 3 && is_identifier(segments[0]) && segments[1..].iter().all(|s| !s.is_empty()) && !type_.contains('"');
    let written = if borrowed { format!("{}-[:{}]->.`{}`", segments[0], segments[1], segments[2]) } else { type_.to_string() };
    format!("<{written}{}>", if nullable { " | null" } else { "" })
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn spelled(name: &str) -> String {
    if is_identifier(name) { name.to_string() } else { format!("`{name}`") }
}
