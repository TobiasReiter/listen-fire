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
}

const fn p(ty: ParamType) -> Param {
    Param { ty, arity: Arity::One }
}
const fn opt(ty: ParamType) -> Param {
    Param { ty, arity: Arity::Optional }
}
const fn rest(ty: ParamType) -> Param {
    Param { ty, arity: Arity::Rest }
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
    b!("ISNULL", [p(T::Any)], R::Boolean),
    b!("COALESCE", [rest(T::Any)], R::Derived),
    b!("TRIM", [p(T::Text)], R::Text),
    b!("LOWER", [p(T::Text)], R::Text),
    b!("UPPER", [p(T::Text)], R::Text),
    b!("LENGTH", [p(T::TextOrList)], R::Number),
    b!("ABS", [p(T::Number)], R::Number),
    b!("ROUND", [p(T::Number), opt(T::Number)], R::Number),
    b!("FLOOR", [p(T::Number)], R::Number),
    b!("CEIL", [p(T::Number)], R::Number),
    b!("TOSTRING", [p(T::Scalar)], R::Text),
    b!("TONUMBER", [p(T::Scalar)], R::Number),
    b!("MULTI", [rest(T::Any)], R::Derived),
    b!("SPLIT", [p(T::Text), opt(T::Text)], R::ListOfText),
    b!("DATE", [p(T::Scalar)], R::Date),
    b!("DATETIME", [p(T::Scalar)], R::Datetime),
    b!("NUMBER", [p(T::Scalar)], R::Number),
    b!("FIRST", [p(T::Any)], R::Derived),
    b!("LAST", [p(T::Any)], R::Derived),
    b!("ONLY", [p(T::Any)], R::Derived),
    b!("COUNT", [p(T::Any)], R::Number),
    b!("SUM", [p(T::Any)], R::Number),
    b!("AVG", [p(T::Any)], R::Number),
    b!("MIN", [p(T::Any)], R::Derived),
    b!("MAX", [p(T::Any)], R::Derived),
    b!("JOIN", [p(T::Any), opt(T::Text)], R::Text),
    b!("COLLECT", [p(T::Any)], R::Derived),
    b!("LLM_AGG", [p(T::Any), opt(T::Text)], R::Derived),
    b!("AI", [p(T::Text), opt(T::Text)], R::Derived),
    b!("CONCAT", [rest(T::Scalar)], R::Text),
    b!("KG_EXISTS", [p(T::Text), rest(T::Any)], R::Boolean),
    b!("KG_VALUE", [p(T::Text), rest(T::Any)], R::Derived),
    b!("EXTRACT_VALUE", [rest(T::Any)], R::Derived),
    b!("AT", [p(T::Any), p(T::Any)], R::Derived),
    b!("SORT", [p(T::Any), opt(T::Any), opt(T::Any)], R::Derived),
    b!("FILE", [p(T::Any), p(T::Text)], R::File),
    b!("READ", [p(T::File)], R::Text),
    b!("CHUNKS", [p(T::Text), p(T::Options)], R::Derived),
    b!("EXISTS", [p(T::Any)], R::Boolean),
    b!("MAP", [p(T::List), opt(T::Options), p(T::Function)], R::Derived),
    b!("FILTER", [p(T::List), opt(T::Options), p(T::Function)], R::Derived),
    b!("REDUCE", [p(T::List), p(T::Any), p(T::Function)], R::Derived),
    b!("GROUPBY", [p(T::List), p(T::Function)], R::Derived),
    b!("KEYBY", [p(T::List), p(T::Function)], R::Derived),
    b!("MEMBERS", [p(T::Type)], R::Derived),
    b!("EXTRACT", [p(T::Any), p(T::Shape), opt(T::Options)], R::Derived),
    b!("EXTRACTONE", [p(T::Any), p(T::Shape), opt(T::Options)], R::Derived),
    b!("CURRENCY.GET_NUMBER_FROM_FIGURE", [p(T::Text)], R::Number, family),
    b!("CURRENCY.GET_CODE_FROM_FIGURE", [p(T::Text)], R::Text, family),
    b!("CURRENCY.FORMAT_FIGURE", [p(T::Number), p(T::Text)], R::MaybeAbsentText, family),
    b!("DATE.PARSE", [p(T::Text)], R::MaybeAbsentDate, family),
    b!("DATE.ADD_DAYS", [p(T::Temporal), p(T::Number)], R::Date, family),
    b!("DATE.FORMAT", [p(T::Temporal), p(T::Text)], R::Text, family),
    b!("DATE.FORMAT_ISO", [p(T::Temporal)], R::Date, family),
    b!("DATE.TODAY", [p(T::Text)], R::Date, family),
    b!("DATETIME.AT", [p(T::Temporal), p(T::Text), p(T::Text)], R::Datetime, family),
    b!("TEXT.REGEX_EXTRACT", [p(T::Text), p(T::Text), opt(T::Number)], R::Text, family),
    b!("TEXT.SLUG", [p(T::Text)], R::Text, family),
    b!("TEXT.PAIRS", [p(T::Record), opt(T::Text)], R::Text, family),
    b!("TEXT.SERIALISE", [p(T::Any), p(T::Text)], R::Text, family),
    b!("URL.HOST", [p(T::Text)], R::MaybeAbsentText, family),
    b!("NUMBER.FORMAT", [p(T::Number), p(T::Text)], R::MaybeAbsentText, family),
];

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
        Ty::Absent => true,
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
