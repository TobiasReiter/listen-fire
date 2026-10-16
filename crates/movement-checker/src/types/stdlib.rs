//! The standard library's signatures (checker/standard_library.ts and the
//! function families of expression/stdlib.ts): each built-in's parameters
//! and what it returns. Generated from `standardLibrary()` on 2026-10-15;
//! a function added there is added here.

use super::field::{Ty, maybe_absent};

/// `BuiltinParamType`: what a parameter takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamType {
    Scalar,
    Text,
    Number,
    Temporal,
    File,
    TextOrList,
    List,
    Any,
    Record,
    Options,
    Function,
    Type,
    Shape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arity {
    One,
    Optional,
    Rest,
}

#[derive(Debug, Clone, Copy)]
pub struct Param {
    /// As the signature names it (`describeBuiltin`).
    pub name: &'static str,
    pub ty: ParamType,
    pub arity: Arity,
}

/// What a built-in returns: a fixed type, or one derived from its arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Returns {
    Text,
    Number,
    Boolean,
    Date,
    Datetime,
    File,
    ListOfText,
    MaybeAbsentText,
    MaybeAbsentDate,
    /// Never returns: the run fails there (`fail("…")`).
    Never,
    Derived,
}

impl Returns {
    pub fn ty(self) -> Option<Ty> {
        Some(match self {
            Returns::Text => Ty::Text,
            Returns::Number => Ty::Number,
            Returns::Boolean => Ty::Boolean,
            Returns::Date => Ty::Date,
            Returns::Datetime => Ty::Datetime,
            Returns::File => Ty::File,
            Returns::ListOfText => Ty::list(Ty::Text),
            Returns::MaybeAbsentText => maybe_absent(Ty::Text),
            Returns::MaybeAbsentDate => maybe_absent(Ty::Date),
            Returns::Never => Ty::Never,
            Returns::Derived => return None,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Builtin {
    /// As the author writes it (`DATE.PARSE`).
    pub name: &'static str,
    pub params: &'static [Param],
    pub returns: Returns,
    /// A function of a namespaced family (`stdlibFunctionById` finds it).
    pub family: bool,
}

impl Builtin {
    /// `builtinParamAt`: the parameter an argument at `index` binds to.
    pub fn param_at(&self, index: usize) -> Option<&Param> {
        self.params.get(index).or_else(|| self.params.last().filter(|p| p.arity == Arity::Rest))
    }

    /// `describeBuiltin`: the signature as the author reads it (`ROUND(number, places?)`).
    pub fn describe(&self) -> String {
        let params: Vec<String> = self
            .params
            .iter()
            .map(|param| match param.arity {
                Arity::One => param.name.to_string(),
                Arity::Optional => format!("{}?", param.name),
                Arity::Rest => format!("…{}", param.name),
            })
            .collect();
        format!("{}({})", self.name, params.join(", "))
    }
}

const fn p(name: &'static str, ty: ParamType) -> Param {
    Param { name, ty, arity: Arity::One }
}
const fn opt(name: &'static str, ty: ParamType) -> Param {
    Param { name, ty, arity: Arity::Optional }
}
const fn rest(name: &'static str, ty: ParamType) -> Param {
    Param { name, ty, arity: Arity::Rest }
}

use ParamType as T;
use Returns as R;

macro_rules! b {
    ($name:literal, [$($param:expr),*], $returns:expr) => {
        Builtin { name: $name, params: &[$($param),*], returns: $returns, family: false }
    };
    ($name:literal, [$($param:expr),*], $returns:expr, family) => {
        Builtin { name: $name, params: &[$($param),*], returns: $returns, family: true }
    };
}

pub static STANDARD_LIBRARY: &[Builtin] = &[
    b!("ISNULL", [p("value", T::Any)], R::Boolean),
    b!("COALESCE", [rest("values", T::Any)], R::Derived),
    b!("TRIM", [p("text", T::Text)], R::Text),
    b!("LOWER", [p("text", T::Text)], R::Text),
    b!("UPPER", [p("text", T::Text)], R::Text),
    b!("LENGTH", [p("value", T::TextOrList)], R::Number),
    b!("ABS", [p("number", T::Number)], R::Number),
    b!("ROUND", [p("number", T::Number), opt("places", T::Number)], R::Number),
    b!("FLOOR", [p("number", T::Number)], R::Number),
    b!("CEIL", [p("number", T::Number)], R::Number),
    b!("TOSTRING", [p("value", T::Scalar)], R::Text),
    b!("TONUMBER", [p("value", T::Scalar)], R::Number),
    b!("MULTI", [rest("values", T::Any)], R::Derived),
    b!("SPLIT", [p("text", T::Text), opt("separator", T::Text)], R::ListOfText),
    b!("DATE", [p("value", T::Scalar)], R::Date),
    b!("DATETIME", [p("value", T::Scalar)], R::Datetime),
    b!("NUMBER", [p("value", T::Scalar)], R::Number),
    b!("FIRST", [p("collection", T::Any)], R::Derived),
    b!("LAST", [p("collection", T::Any)], R::Derived),
    b!("ONLY", [p("collection", T::Any)], R::Derived),
    b!("COUNT", [p("collection", T::Any)], R::Number),
    b!("SUM", [p("collection", T::Any)], R::Number),
    b!("AVG", [p("collection", T::Any)], R::Number),
    b!("MIN", [p("collection", T::Any)], R::Derived),
    b!("MAX", [p("collection", T::Any)], R::Derived),
    b!("JOIN", [p("collection", T::Any), opt("separator", T::Text)], R::Text),
    b!("COLLECT", [p("collection", T::Any)], R::Derived),
    b!("LLM_AGG", [p("collection", T::Any), opt("instruction", T::Text)], R::Derived),
    b!("AI", [p("prompt", T::Text), opt("tier", T::Text)], R::Derived),
    b!("CONCAT", [rest("parts", T::Scalar)], R::Text),
    b!("KG_EXISTS", [p("query", T::Text), rest("params", T::Any)], R::Boolean),
    b!("KG_VALUE", [p("query", T::Text), rest("params", T::Any)], R::Derived),
    b!("EXTRACT_VALUE", [rest("values", T::Any)], R::Derived),
    b!("AT", [p("collection", T::Any), p("index", T::Any)], R::Derived),
    b!("SORT", [p("collection", T::Any), opt("key", T::Any), opt("direction", T::Any)], R::Derived),
    b!("FILE", [p("content", T::Any), p("type", T::Text)], R::File),
    b!("READ", [p("file", T::File)], R::Text),
    b!("CHUNKS", [p("text", T::Text), p("options", T::Options)], R::Derived),
    b!("EXISTS", [p("walk", T::Any)], R::Boolean),
    b!("MAP", [p("collection", T::List), opt("settings", T::Options), p("function", T::Function)], R::Derived),
    b!("FILTER", [p("collection", T::List), opt("settings", T::Options), p("function", T::Function)], R::Derived),
    b!("REDUCE", [p("collection", T::List), p("start", T::Any), p("function", T::Function)], R::Derived),
    b!("GROUPBY", [p("collection", T::List), p("key", T::Function)], R::Derived),
    b!("KEYBY", [p("collection", T::List), p("key", T::Function)], R::Derived),
    b!("MEMBERS", [p("type", T::Type)], R::Derived),
    b!("EXTRACT", [p("content", T::Any), p("shape", T::Shape), opt("settings", T::Options)], R::Derived),
    b!("EXTRACTONE", [p("content", T::Any), p("shape", T::Shape), opt("settings", T::Options)], R::Derived),
    b!("CURRENCY.GET_NUMBER_FROM_FIGURE", [p("figure", T::Text)], R::Number, family),
    b!("CURRENCY.GET_CODE_FROM_FIGURE", [p("figure", T::Text)], R::Text, family),
    b!("CURRENCY.FORMAT_FIGURE", [p("number", T::Number), p("code", T::Text)], R::MaybeAbsentText, family),
    b!("DATE.PARSE", [p("text", T::Text)], R::MaybeAbsentDate, family),
    b!("DATE.ADD_DAYS", [p("date", T::Temporal), p("days", T::Number)], R::Date, family),
    b!("DATE.FORMAT", [p("value", T::Temporal), p("pattern", T::Text)], R::Text, family),
    b!("DATE.FORMAT_ISO", [p("value", T::Temporal)], R::Date, family),
    b!("DATE.TODAY", [p("zone", T::Text)], R::Date, family),
    b!("DATETIME.AT", [p("date", T::Temporal), p("time", T::Text), p("zone", T::Text)], R::Datetime, family),
    b!("TEXT.REGEX_EXTRACT", [p("text", T::Text), p("pattern", T::Text), opt("group", T::Number)], R::Text, family),
    b!("TEXT.SLUG", [p("text", T::Text)], R::Text, family),
    b!("TEXT.PAIRS", [p("record", T::Record), opt("separator", T::Text)], R::Text, family),
    b!("TEXT.SERIALISE", [p("value", T::Any), p("format", T::Text)], R::Text, family),
    b!("URL.HOST", [p("text", T::Text)], R::MaybeAbsentText, family),
    b!("NUMBER.FORMAT", [p("number", T::Number), p("style", T::Text)], R::MaybeAbsentText, family),
];

/// `fail("…")` inside an expression, from language version 5: its canonical
/// call is `ERROR(…)`, the statement's word, which versions 1–4 never read
/// as a value — so it is no member of the library they read
/// (`builtin_under`).
pub static FAIL: Builtin = b!("ERROR", [p("message", T::Scalar)], R::Never);

/// The built-in `name` calls under `version`: the library's, and from 5 the
/// `fail` of an expression.
pub fn builtin_under(name: &str, version: u32) -> Option<&'static Builtin> {
    if movement_parser::version::since(version, 5) && name == FAIL.name {
        return Some(&FAIL);
    }
    lookup_builtin(name)
}

/// `lookupBuiltin`: by name, in any letter case.
pub fn lookup_builtin(name: &str) -> Option<&'static Builtin> {
    STANDARD_LIBRARY.iter().find(|b| b.name.eq_ignore_ascii_case(name))
}

/// `stdlibFunctionById`: a namespaced family's function, by its lowercased id.
pub fn stdlib_function_by_id(id: &str) -> Option<&'static Builtin> {
    lookup_builtin(id).filter(|b| b.family)
}

/// `readsAsValue`: whether a parameter reads its argument as a value.
pub fn reads_as_value(param: ParamType) -> bool {
    matches!(param, T::Scalar | T::Text | T::Number | T::Temporal | T::File | T::TextOrList | T::List)
}

/// `paramAccepts`: whether a value of `ty` is one `param` takes.
pub fn param_accepts(param: ParamType, ty: &Ty) -> bool {
    match ty {
        Ty::MaybeAbsent(of) => param_accepts(param, of),
        Ty::Absent | Ty::Never => true,
        Ty::Union(members) => members.iter().all(|m| param_accepts(param, m)),
        Ty::Text | Ty::Enum { .. } => matches!(param, T::Scalar | T::Text | T::Temporal | T::TextOrList),
        Ty::Number => matches!(param, T::Scalar | T::Number),
        Ty::Boolean => param == T::Scalar,
        Ty::Date | Ty::Datetime => matches!(param, T::Scalar | T::Temporal),
        Ty::File => param == T::File,
        Ty::List { .. } | Ty::Tuple { .. } => matches!(param, T::List | T::TextOrList),
        Ty::Json | Ty::Record(_) | Ty::Dict { .. } => false,
    }
}

/// `describeParamType`.
pub fn describe_param_type(param: ParamType) -> &'static str {
    match param {
        T::Scalar => "one plain value (text, a number, a boolean or a date)",
        T::Text => "text",
        T::Number => "a number",
        T::Temporal => "a date, a datetime, or text that reads as one",
        T::File => "a file",
        T::TextOrList => "text or a list",
        T::List => "a list",
        T::Any => "any value",
        T::Record => "a record or a dict",
        T::Options => "a map of settings",
        T::Function => "a function",
        T::Type => "a type",
        T::Shape => "a node declaration",
    }
}

/// `BARE_COERCER_RETURNS`: the bare coercers and the type they retype to.
pub fn bare_coercer_returns(function: &str) -> Option<Ty> {
    match function {
        "date" => Some(Ty::Date),
        "datetime" => Some(Ty::Datetime),
        "number" => Some(Ty::Number),
        _ => None,
    }
}

/// `movementMetaKeyType` (checker/meta.ts): what an `@key` read is.
pub fn movement_meta_key_type(key: &str) -> Option<Ty> {
    match key {
        "current_date" => Some(Ty::Date),
        "current_timestamp" => Some(Ty::Datetime),
        "user_email" | "user_name" | "user_id" | "actor_email" | "actor_name" | "actor_id" => Some(Ty::Text),
        _ => None,
    }
}
