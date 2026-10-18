//! Completion: what the text just before the cursor is decides what is
//! offered (docs/contracts/language-service.md, "What a position answers").

use movement_checker::scope::SymbolKind;
use movement_parser::surface::table::plugin_name;
use movement_parser::version::run_host_units;

use crate::recover::open_brackets_at;
use crate::text::{Pos, Range, Text, inside_backticks, loc_of, trailing_word, utf16_len, written_name};
use crate::{Service, builtins, walk};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Variable,
    Function,
    Field,
    Edge,
    Module,
    Keyword,
    Property,
    Credential,
    Type,
    Namespace,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub label: String,
    pub kind: ItemKind,
    pub detail: Option<String>,
    /// The text written, when it is not the label.
    pub insert: Option<String>,
    /// The text it replaces, when that is not the word before the cursor
    /// (a backticked name's partial text).
    pub replace: Option<Range>,
}

impl Item {
    fn new(label: impl Into<String>, kind: ItemKind, detail: Option<String>) -> Self {
        Item { label: label.into(), kind, detail, insert: None, replace: None }
    }
}

/// What the cursor is in.
enum Context {
    /// `x.`, ``x.` ``: a field of the record `receiver` (the text before the dot) holds.
    Field { receiver: String, backtick: bool },
    /// `Text.`: a namespace's functions.
    Member { namespace: String },
    /// `-[`, `-[a:`: an edge off the record `receiver` holds.
    Edge { receiver: String, backtick: bool },
    /// `<x-[:`: a record type of instance `x`.
    TypeOf { instance: String },
    /// `connect x using `: a credential for module `x`.
    Credential { module: String },
    /// `listen to x { `: a settings key.
    SettingsKey { source: String },
    /// `import { ` … `} from <source>`.
    ImportName { source: Option<String> },
    Name,
}

const KEYWORDS: &[&str] = &[
    "function", "listen", "to", "fire", "import", "from", "export", "connect", "using", "return", "if", "else", "await", "node", "type", "true", "false", "null",
];

fn context_of(text: &Text<'_>, pos: Pos) -> (Context, Option<Range>) {
    let line = text.line_before(pos);
    let above = text.before(Pos { line: pos.line, character: 0 });
    let everything_before = text.before(pos);
    if inside_backticks(line) {
        let open = line.rfind('`').unwrap_or(0);
        let start = Pos { line: pos.line, character: utf16_len(&line[..open + 1]) as u32 };
        let replace = Some(Range { start, end: pos });
        let pre = &line[..open];
        if let Some(receiver) = pre.strip_suffix('.') {
            return (Context::Field { receiver: format!("{above}{receiver}"), backtick: true }, replace);
        }
        if let Some(receiver) = hop_receiver(pre) {
            return (Context::Edge { receiver: format!("{above}{receiver}"), backtick: true }, replace);
        }
        return (brace_context(&everything_before, &text.after(pos)).unwrap_or(Context::Name), replace);
    }
    let partial = trailing_word(line);
    let pre = &line[..line.len() - partial.len()];
    if let Some(receiver) = pre.strip_suffix('.') {
        let name = walk::trailing_name(receiver).unwrap_or_default();
        if builtins::namespaces().contains(&name.as_str()) {
            return (Context::Member { namespace: name }, None);
        }
        return (Context::Field { receiver: format!("{above}{receiver}"), backtick: false }, None);
    }
    if let Some(receiver) = hop_receiver(pre) {
        if let Some(instance) = receiver.trim_end().strip_suffix(trailing_word(receiver.trim_end())).filter(|r| r.ends_with('<')).map(|_| trailing_word(receiver.trim_end()).to_string()) {
            return (Context::TypeOf { instance }, None);
        }
        return (Context::Edge { receiver: format!("{above}{receiver}"), backtick: false }, None);
    }
    let words: Vec<&str> = pre.split_whitespace().collect();
    if let [.., connect, module, using] = words.as_slice()
        && *connect == "connect"
        && *using == "using"
    {
        return (Context::Credential { module: module.to_string() }, None);
    }
    (brace_context(&everything_before, &text.after(pos)).unwrap_or(Context::Name), None)
}

/// `pre` ends a hop's opening: `-[` or `-[a:` — the receiver is the text before it.
fn hop_receiver(pre: &str) -> Option<&str> {
    if let Some(receiver) = pre.strip_suffix("-[") {
        return Some(receiver);
    }
    let head = pre.strip_suffix(':')?;
    head.strip_suffix(trailing_word(head))?.strip_suffix("-[")
}

/// Inside an unclosed `{ … }`: a listen's settings, or an import's names.
fn brace_context(before: &str, after: &str) -> Option<Context> {
    let (brace, _) = open_brackets_at(before).into_iter().rev().find(|(_, c)| *c == '{')?;
    let inside = &before[brace + 1..];
    let head = &before[..brace];
    let statement = head.rsplit('\n').next().unwrap_or(head).trim();
    if let Some(source) = statement.strip_prefix("listen to ") {
        // A key, not a value: nothing since the last `,` but the key itself.
        let since = inside.rsplit(',').next().unwrap_or(inside);
        if since.contains(':') {
            return None;
        }
        return Some(Context::SettingsKey { source: source.trim().to_string() });
    }
    if statement == "import" || statement.ends_with(" import") {
        let rest = &after[after.find('}')? + 1..];
        let source = rest.trim_start().strip_prefix("from").map(|r| r.split_whitespace().next().unwrap_or("").trim_matches('"').to_string());
        return Some(Context::ImportName { source });
    }
    None
}

pub fn complete(service: &Service, source: &str, pos: Pos) -> Vec<Item> {
    let text = Text::new(source);
    let (context, replace) = context_of(&text, pos);
    let mut items = items_for(service, source, pos, context);
    if replace.is_some() {
        for item in &mut items {
            item.replace = replace;
        }
    }
    items
}

fn items_for(service: &Service, source: &str, pos: Pos, context: Context) -> Vec<Item> {
    let at = loc_of(pos);
    let version = service.language_version;
    let catalog = &service.catalog;
    match context {
        Context::Member { namespace } => {
            let prefix = format!("{namespace}.");
            builtins::v5_builtins()
                .into_iter()
                .filter_map(|b| b.name.strip_prefix(&prefix).map(|member| Item::new(member, ItemKind::Function, Some(b.signature()))))
                .collect()
        }
        Context::Field { receiver, backtick } => {
            let Some(analyzed) = service.analyze(source, Some(pos.line)) else { return Vec::new() };
            let analysis = &analyzed.analysis;
            if let Some(position) = walk::receiver(analysis, &receiver, at, version) {
                return walk::fields(&position)
                    .into_iter()
                    .map(|(name, ty)| {
                        let insert = if backtick { None } else { Some(written_name(&name)).filter(|w| *w != name) };
                        Item { insert, ..Item::new(name, ItemKind::Field, ty) }
                    })
                    .collect();
            }
            // A package's members, bound as `web.fetchUrl`.
            let prefix = format!("{}.", walk::trailing_name(receiver.trim_end()).unwrap_or_default());
            analysis
                .visible(at)
                .into_iter()
                .filter_map(|v| v.symbol.name.strip_prefix(&prefix).map(|member| Item::new(member, ItemKind::Function, Some(v.symbol.kind.describe().to_string()))))
                .collect()
        }
        Context::Edge { receiver, backtick } => {
            let Some(analyzed) = service.analyze(source, Some(pos.line)) else { return Vec::new() };
            let Some(position) = walk::receiver(&analyzed.analysis, &receiver, at, version) else { return Vec::new() };
            walk::edges(&position, version)
                .into_iter()
                .map(|(name, landing)| {
                    let insert = if backtick { None } else { Some(written_name(&name)).filter(|w| *w != name) };
                    Item { insert, ..Item::new(name, ItemKind::Edge, Some(format!("→ {landing}"))) }
                })
                .collect()
        }
        Context::TypeOf { instance } => {
            let Some(analyzed) = service.analyze(source, Some(pos.line)) else { return Vec::new() };
            let analysis = &analyzed.analysis;
            let Some(id) = analysis.resolve(at, &instance) else { return Vec::new() };
            let symbol = analysis.symbol(id);
            let schema = match (&symbol.types.pos, &symbol.instance) {
                (Some(movement_checker::types::Position::Meta { instance }), _) => Some((*instance.schema).clone()),
                (_, Some(built)) => built.schema.clone(),
                _ => None,
            };
            let Some(schema) = schema else { return Vec::new() };
            let mut items: Vec<Item> = schema
                .positions
                .iter()
                .map(|(name, p)| Item { insert: Some(written_name(name)).filter(|w| w != name), ..Item::new(name, ItemKind::Type, p.display_name.clone()) })
                .collect();
            if let Some(unions) = &schema.unions {
                items.extend(unions.iter().map(|(name, variants)| Item::new(name, ItemKind::Type, Some(format!("one of {}", variants.join(", "))))));
            }
            items
        }
        Context::Credential { module } => {
            let key = service
                .analyze(source, Some(pos.line))
                .and_then(|a| {
                    let id = a.analysis.resolve(at, &module)?;
                    let symbol = a.analysis.symbol(id);
                    Some(symbol.imported_name.clone().or_else(|| symbol.adapter.clone()).unwrap_or_else(|| symbol.name.clone()))
                })
                .unwrap_or(module);
            let bare = key.trim_matches('`').strip_prefix("@lf/").unwrap_or(key.trim_matches('`')).to_string();
            let mut names: Vec<Item> = catalog
                .credential_names()
                .into_iter()
                .filter_map(|name| {
                    let spec = catalog.credential(name)?;
                    spec.adapters.iter().any(|a| a == &bare || a == &key).then(|| Item {
                        insert: Some(written_name(name)).filter(|w| w != name),
                        ..Item::new(name, ItemKind::Credential, Some(format!("a credential for {bare}")))
                    })
                })
                .collect();
            if names.is_empty() {
                names = catalog.credential_names().into_iter().map(|name| Item::new(name, ItemKind::Credential, None)).collect();
            }
            names
        }
        Context::SettingsKey { source: listened } => {
            let adapter = service
                .analyze(source, Some(pos.line))
                .and_then(|a| {
                    let id = a.analysis.resolve(at, &listened)?;
                    let symbol = a.analysis.symbol(id);
                    symbol.adapter.clone().or_else(|| symbol.imported_name.clone()).or_else(|| Some(symbol.name.clone()))
                })
                .unwrap_or(listened);
            let bare = adapter.trim_matches('`').strip_prefix("@lf/").unwrap_or(adapter.trim_matches('`')).to_string();
            let spec = catalog.adapter(&bare).or_else(|| catalog.adapter(&adapter));
            let mut keys: Vec<String> = spec
                .and_then(|s| s.trigger_config.clone())
                .unwrap_or_default()
                .into_iter()
                .map(|k| if version >= 5 && k == "pollIntervalSeconds" { "every".to_string() } else { k })
                .collect();
            keys.push("suppress_self".into());
            let required = spec.and_then(|s| s.trigger_config_required.clone()).unwrap_or_default();
            keys.into_iter()
                .map(|key| {
                    let detail = Some(if required.contains(&key) { format!("required by {bare}") } else { format!("a setting of {bare}") });
                    Item { insert: Some(format!("{key}: ")), ..Item::new(key, ItemKind::Property, detail) }
                })
                .collect()
        }
        Context::ImportName { source: from } => import_items(service, from.as_deref()),
        Context::Name => {
            let mut items: Vec<Item> = Vec::new();
            if let Some(analyzed) = service.analyze(source, Some(pos.line)) {
                let analysis = &analyzed.analysis;
                for v in analysis.visible(at) {
                    if v.symbol.name.contains('.') {
                        continue;
                    }
                    let kind = match v.symbol.kind {
                        SymbolKind::Movement | SymbolKind::Plugin | SymbolKind::FileImport => ItemKind::Function,
                        SymbolKind::Shape | SymbolKind::Type => ItemKind::Type,
                        SymbolKind::Adapter | SymbolKind::Instance => ItemKind::Module,
                        SymbolKind::Credential => ItemKind::Credential,
                        _ if v.symbol.is_closure => ItemKind::Function,
                        _ => ItemKind::Variable,
                    };
                    let detail = analysis.type_text(v.id).or_else(|| Some(v.symbol.kind.describe().to_string()));
                    items.push(Item { insert: Some(written_name(&v.symbol.name)).filter(|w| *w != v.symbol.name), ..Item::new(v.symbol.name.clone(), kind, detail) });
                }
            }
            for b in builtins::v5_builtins().into_iter().filter(|b| !b.name.contains('.')) {
                items.push(Item::new(b.name, ItemKind::Function, Some(b.signature())));
            }
            items.extend(builtins::grammar_words().map(|w| Item::new(w, ItemKind::Keyword, None)));
            items.extend(builtins::namespaces().iter().map(|n| Item::new(*n, ItemKind::Namespace, Some("standard namespace".into()))));
            items.extend(KEYWORDS.iter().map(|k| Item::new(*k, ItemKind::Keyword, None)));
            let mut seen = std::collections::HashSet::new();
            items.retain(|item| seen.insert(item.label.clone()));
            items
        }
    }
}

/// What an import's braces may name, by where it imports from.
fn import_items(service: &Service, from: Option<&str>) -> Vec<Item> {
    let catalog = &service.catalog;
    let units = run_host_units(service.language_version);
    let adapters = || {
        catalog
            .adapters
            .keys()
            .filter(|key| !units.contains(&key.as_str()))
            .map(|key| {
                let tag = if key.contains('/') { key.clone() } else { format!("@lf/{key}") };
                Item { insert: Some(format!("`{tag}` as {}", local_of(key))), ..Item::new(format!("`{tag}`"), ItemKind::Module, Some("module".into())) }
            })
            .collect::<Vec<_>>()
    };
    let plugins = || {
        let mut items: Vec<Item> = Vec::new();
        for (key, spec) in catalog.plugins.iter() {
            match &spec.package {
                Some(tag) => {
                    if !items.iter().any(|i| i.label == format!("`{tag}`")) {
                        items.push(Item { insert: Some(format!("`{tag}` as {}", local_of(tag))), ..Item::new(format!("`{tag}`"), ItemKind::Module, Some("plugin package".into())) });
                    }
                }
                None => items.push(Item::new(plugin_name(key), ItemKind::Function, Some("plugin".into()))),
            }
        }
        items
    };
    match from {
        Some("adapters") => adapters(),
        Some("plugins") => plugins(),
        Some(path) if !path.is_empty() => library_exports(service, path),
        _ => adapters().into_iter().chain(plugins()).collect(),
    }
}

/// `@lf/web-tools` → `webTools`.
fn local_of(tag: &str) -> String {
    let last = tag.rsplit('/').next().unwrap_or(tag);
    let mut out = String::new();
    let mut upper = false;
    for c in last.chars() {
        if c == '-' || c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// The movements and nodes a library exports.
fn library_exports(service: &Service, path: &str) -> Vec<Item> {
    use movement_parser::ast::Statement;
    let Some(file) = service.catalog.files.as_ref().and_then(|files| files.get(path)) else { return Vec::new() };
    let Ok(program) = crate::recover::parse(&file.source, service.language_version) else { return Vec::new() };
    program
        .statements
        .iter()
        .filter_map(|s| match s {
            Statement::Movement(m) if m.exported == Some(true) => Some(Item::new(&m.name, ItemKind::Function, Some(format!("exported from \"{path}\"")))),
            Statement::Shape(n) if n.exported == Some(true) => Some(Item::new(&n.name, ItemKind::Type, Some(format!("exported from \"{path}\"")))),
            _ => None,
        })
        .collect()
}
