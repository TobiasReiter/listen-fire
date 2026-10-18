//! Built-ins as language version 5 spells them: the spelling table's v5
//! names, with each one's signature from the standard library's.

use movement_checker::types::stdlib::{Builtin, ParamType, lookup_builtin};
use movement_parser::surface::table::{CORE_WORDS, NAMESPACES, SPELLINGS, Shape, Spelling, by_v5};

/// One built-in a v5 program calls.
pub struct V5Builtin {
    pub name: &'static str,
    pub spelling: &'static Spelling,
}

/// Every built-in a v5 program calls by name (operators and indexing left out).
pub fn v5_builtins() -> Vec<V5Builtin> {
    let mut out: Vec<V5Builtin> = Vec::new();
    for spelling in SPELLINGS.iter().filter(|s| !s.old_only) {
        let name = spelling.v5;
        if !name.chars().all(|c| c.is_alphanumeric() || c == '.') || out.iter().any(|b| b.name == name) {
            continue;
        }
        out.push(V5Builtin { name, spelling });
    }
    out
}

/// The core words the grammar reads that are not in the table (`sleep`, `race`, …).
pub fn grammar_words() -> impl Iterator<Item = &'static str> {
    CORE_WORDS.iter().copied().filter(|w| !SPELLINGS.iter().any(|s| s.v5 == *w))
}

pub fn namespaces() -> &'static [&'static str] {
    NAMESPACES
}

/// The built-in written `name` under version 5.
pub fn by_name(name: &str) -> Option<V5Builtin> {
    by_v5(name).map(|spelling| V5Builtin { name: spelling.v5, spelling })
}

fn param_text(param: &movement_checker::types::stdlib::Param) -> String {
    use movement_checker::types::stdlib::Arity;
    match param.arity {
        Arity::One => param.name.to_string(),
        Arity::Optional => format!("{}?", param.name),
        Arity::Rest => format!("…{}", param.name),
    }
}

impl V5Builtin {
    fn library(&self) -> Option<&'static Builtin> {
        lookup_builtin(self.spelling.canonical)
    }

    /// `Text.upper(text)`, its parameters in the order v5 writes them.
    pub fn signature(&self) -> String {
        let Some(builtin) = self.library() else { return format!("{}(…)", self.name) };
        let mut params: Vec<String> = builtin.params.iter().map(param_text).collect();
        match self.spelling.shape {
            Shape::SettingsLast => {
                if let Some(at) = builtin.params.iter().position(|p| p.ty == ParamType::Options) {
                    let settings = params.remove(at);
                    params.push(settings);
                }
            }
            Shape::ReduceOrder if params.len() >= 3 => params.swap(1, 2),
            _ => {}
        }
        format!("{}({})", self.name, params.join(", "))
    }

    /// One line: what it returns, and its spelling before version 5.
    pub fn doc(&self) -> String {
        use movement_checker::types::stdlib::Returns;
        let returns = match self.library().map(|b| b.returns) {
            Some(Returns::Text) => "Returns text.",
            Some(Returns::Number) => "Returns a number.",
            Some(Returns::Boolean) => "Returns true or false.",
            Some(Returns::Date) => "Returns a date.",
            Some(Returns::Datetime) => "Returns a date and time.",
            Some(Returns::File) => "Returns a file.",
            Some(Returns::ListOfText) => "Returns a list of text.",
            Some(Returns::MaybeAbsentText) => "Returns text, or null.",
            Some(Returns::MaybeAbsentDate) => "Returns a date, or null.",
            Some(Returns::Never) => "Fails the run here.",
            Some(Returns::Derived) | None => "Its type follows from its arguments.",
        };
        format!("{returns} Written `{}` before version 5.", self.spelling.canonical)
    }
}
