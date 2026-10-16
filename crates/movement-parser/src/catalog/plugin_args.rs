//! A plugin's arguments by position (language version 5, design §2.7): its
//! required inputs in the manifest's declared order, then one optional
//! settings record `{ name: value }` for the rest. Binding turns that call
//! into the named arguments versions 1–4 write, so every check and the wire
//! to the plugin read one form. The TypeScript twin is `bindPluginArgs` in
//! packages/movement-lang/checker/catalog.ts; both checkers and both engines
//! bind through these two and nothing else.

use crate::ast::{CallArg, ExprSlot, NamedArg, PluginCall, Span};
use crate::catalog::types::PluginSpec;
use crate::tree::{MExpr, MapKey, MapMember};
use crate::util::utf16::Utf16;

/// Where a plugin is called: a plain call writes the arguments a stage is
/// fed, a `through [ … ]` stage never does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginCallSite {
    Plain,
    Stage,
}

/// A positional call that does not fit the plugin's parameters.
#[derive(Debug, Clone, PartialEq)]
pub enum PluginArgMisfit {
    /// An argument past the positional parameters that is not the settings record.
    Extra { span: Span },
    /// A settings key that names a parameter taken by position.
    SettingIsPositional { name: String, span: Span },
    /// A settings record member that is not `name: value`.
    SettingNotNamed { span: Span },
}

impl PluginArgMisfit {
    pub fn span(&self) -> Span {
        match self {
            PluginArgMisfit::Extra { span } | PluginArgMisfit::SettingIsPositional { span, .. } | PluginArgMisfit::SettingNotNamed { span } => *span,
        }
    }

    /// What is wrong, in the words both checkers report (MOV_THROUGH_BAD_ARG).
    pub fn message(&self, callee: &str, positional: &[&str]) -> String {
        match self {
            PluginArgMisfit::Extra { .. } => {
                let by_position = match positional {
                    [] => "no argument by position".to_string(),
                    [one] => format!("one argument by position ({one})"),
                    many => format!("{} arguments by position ({})", many.len(), many.join(", ")),
                };
                format!("'{callee}' takes {by_position}, then its settings as one record `{{ name: value }}` — this argument is past them")
            }
            PluginArgMisfit::SettingIsPositional { name, .. } => {
                format!("'{name}' is an argument '{callee}' takes by position — write it in its place, not in the settings record")
            }
            PluginArgMisfit::SettingNotNamed { .. } => format!("'{callee}'s settings record holds only `name: value` entries"),
        }
    }
}

/// A call's arguments, bound to the plugin's parameters by name.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginArgBinding {
    pub args: Vec<CallArg>,
    pub misfits: Vec<PluginArgMisfit>,
}

impl PluginSpec {
    /// The parameters a call fills by position, in the manifest's declared
    /// order. The spec keeps the fed parameters apart from the author's, and
    /// every plugin declares its fed one first, so fed-then-author is that order.
    pub fn positional_params(&self, site: PluginCallSite) -> Vec<&str> {
        let fed = match site {
            PluginCallSite::Plain => self.fed_args.iter().flatten().filter(|fed| fed.required == Some(true)).map(|fed| fed.name.as_str()).collect(),
            PluginCallSite::Stage => Vec::new(),
        };
        let required = self.required_args.as_deref().unwrap_or_default();
        fed.into_iter().chain(self.args.iter().filter(|a| required.contains(a)).map(String::as_str)).collect()
    }

    /// `bindPluginArgs`: positional arguments named by `positional_params`;
    /// the argument after those, written as a record literal, is the
    /// settings, each entry a named argument whose value is its own slot;
    /// any further one is a misfit. A named argument stays as written.
    pub fn bind_args(&self, site: PluginCallSite, args: &[CallArg]) -> PluginArgBinding {
        let params = self.positional_params(site);
        let positional: Vec<&CallArg> = args.iter().filter(|a| a.name().is_none()).collect();
        let settings = positional.get(params.len()).and_then(|arg| record_literal(arg));
        let mut binding = PluginArgBinding { args: Vec::new(), misfits: Vec::new() };
        let mut at = 0;
        for arg in args {
            if arg.name().is_some() {
                binding.args.push(arg.clone());
                continue;
            }
            let index = at;
            at += 1;
            if let Some(param) = params.get(index) {
                binding.args.push(arg.clone().named(param));
                continue;
            }
            match &settings {
                Some(record) if index == params.len() => bind_settings(record, &params, &mut binding),
                _ => binding.misfits.push(PluginArgMisfit::Extra { span: arg.span() }),
            }
        }
        binding
    }
}

/// A `through [ … ]` stage's arguments, bound to the plugin's parameters by name.
#[derive(Debug, Clone, PartialEq)]
pub struct StageArgBinding {
    pub args: Vec<NamedArg>,
    pub misfits: Vec<PluginArgMisfit>,
}

impl PluginSpec {
    /// `bindStageArgs`: a stage's positional arguments bound as a call's are,
    /// with the stage's positional parameters (never a fed one).
    pub fn bind_stage_args(&self, stage: &PluginCall) -> StageArgBinding {
        let args: Vec<CallArg> = stage.positional.iter().map(|slot| CallArg::Expr { name: None, expr: slot.clone() }).collect();
        let bound = self.bind_args(PluginCallSite::Stage, &args);
        let named = bound.args.into_iter().filter_map(|arg| match arg {
            CallArg::Expr { name: Some(name), expr } => Some(NamedArg { name, value: expr, is_type: None }),
            // Binding names an expression and makes nothing else.
            _ => None,
        });
        StageArgBinding { args: stage.args.iter().cloned().chain(named).collect(), misfits: bound.misfits }
    }
}

/// A record literal argument: its slot and its parse.
struct RecordLiteral<'a> {
    slot: &'a ExprSlot,
    tree: MExpr,
}

fn record_literal(arg: &CallArg) -> Option<RecordLiteral<'_>> {
    let CallArg::Expr { expr, .. } = arg else { return None };
    let tree = crate::expr::parse_expression_raw(&expr.raw).ok()?;
    matches!(tree, MExpr::Map { .. }).then_some(RecordLiteral { slot: expr, tree })
}

fn bind_settings(record: &RecordLiteral<'_>, params: &[&str], binding: &mut PluginArgBinding) {
    let src = Utf16::new(&record.slot.raw);
    let span_of = |start: usize, end: usize| Span {
        start: crate::surface::loc_in(&src, record.slot.span.start, start),
        end: crate::surface::loc_in(&src, record.slot.span.start, end),
    };
    let MExpr::Map { entries, .. } = &record.tree else { return };
    for member in entries {
        match member {
            MapMember::Entry { key: MapKey::Name(key), value } => {
                let at = value.at();
                let span = span_of(at.start, at.end);
                if params.contains(&key.text.as_str()) {
                    binding.misfits.push(PluginArgMisfit::SettingIsPositional { name: key.text.clone(), span: span_of(key.at.start, key.at.end) });
                    continue;
                }
                binding.args.push(CallArg::Expr { name: Some(key.text.clone()), expr: ExprSlot::plain(src.text(at.start, at.end), span) });
            }
            MapMember::Entry { key: MapKey::String(key), .. } => binding.misfits.push(PluginArgMisfit::SettingNotNamed { span: span_of(key.at.start, key.at.end) }),
            MapMember::Spread(spread) => binding.misfits.push(PluginArgMisfit::SettingNotNamed { span: span_of(spread.at.start, spread.at.end) }),
        }
    }
}
