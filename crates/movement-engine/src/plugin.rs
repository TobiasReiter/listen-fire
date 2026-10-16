//! A plugin called plainly (run.ts `executePluginCall`): `page =
//! fetch_url(url: c.website)`, `x = p()`, or `p(…)` as a statement. Its named
//! arguments are evaluated in the order written and handed to the plugin as
//! its config; the invocation is timed (`clock.now` either side), refused
//! before the host is asked when the plugin is priced and the cap is spent,
//! and traced; what comes back is bound as the plugin's DECLARED output under
//! the movement's pin (`pluginOutputUnder`): a `value` output its text, a
//! `record` output a node of the fields it attached (its text under `text`),
//! a `records` output one such node per record it found.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::catalog::plugin_args::PluginCallSite;
use movement_parser::catalog::types::{JsMap, PluginOutput, PluginSpec};

use crate::bindings::{Binding, Node, Scope};
use crate::env::{Trail, ValueBinding};
use crate::js::{Js, JsObject};
use movement_parser::ast::CallArg;

use crate::run::{Address, Failure, Run, Stop};
use crate::trace::{Members, TraceEntry};

/// The field a `record` output hands its fetched text back under.
const FETCHED_TEXT_FIELD: &str = "text";

/// `pluginSpecNamed`: a plugin by either spelling — a program writes
/// `vc_url_retrieval` for a plugin registered as `vc-url-retrieval`, and the
/// snapshot keys the underscore one.
pub fn spec_named<'p>(plugins: &'p JsMap<PluginSpec>, plugin: &str) -> Option<&'p PluginSpec> {
    plugins.get(&plugin.replace('-', "_"))
}

/// `pluginOutputUnder`: the output a movement pinned at `language_version`
/// gets — an earlier one for a pin before the change, else the current.
pub fn output_under(spec: &PluginSpec, language_version: u32) -> Option<&PluginOutput> {
    let earlier = spec.earlier_outputs.iter().flatten().find(|entry| language_version < entry.before);
    earlier.map(|entry| &entry.output).or(spec.output.as_ref())
}

/// `{ ...record }` and `Object.keys(record)` of what a records output found:
/// an object's own fields, a list's or a text's by index, nothing of a
/// number or a flag; null and undefined throw, as `Object.keys` throws.
fn spread_fields(record: &Js) -> Result<JsObject, Stop> {
    let mut fields = JsObject::new();
    match record {
        Js::Object(object) => return Ok(JsObject::clone_of(object)),
        Js::Undefined | Js::Null => {
            return Err(Stop::Thrown(Failure::Engine { class: crate::eval::ErrorClass::TypeError, message: "Cannot convert undefined or null to object".into() }));
        }
        Js::Array(list) => {
            for (i, item) in list.items().iter().enumerate() {
                fields.set(i.to_string(), item.clone());
            }
        }
        // By UTF-16 unit: an astral character spreads as its two halves.
        Js::String(text) => {
            for (i, unit) in crate::js_string::split_units(text.as_form()).into_iter().enumerate() {
                fields.set(i.to_string(), Js::str(unit));
            }
        }
        _ => {}
    }
    Ok(fields)
}

impl Run<'_> {
    /// `executeCall` for a plugin: the statement's next call opened (so it is
    /// numbered, a `suspendAt` before it suspends, and a statement re-run
    /// hands back what it bound rather than invoking it again), then
    /// `executePluginCall`.
    pub(crate) async fn plugin_call(&self, written: &str, args: &[CallArg], scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Binding, Stop> {
        let event = self.begin_call_event().await?;
        if let Some(replayed) = &event.replayed {
            return Ok(replayed.value.clone().unwrap_or_else(|| Binding::Value(ValueBinding { value: Js::Undefined, trail: None, many: false })));
        }
        let bound = self.invoke_plugin(written, args, scope, at, path).await?;
        self.finish_call(&event, Some(&bound));
        Ok(bound)
    }

    /// `executePluginCall`: `args` are the call's named arguments, in the
    /// order written.
    pub(crate) async fn invoke_plugin(&self, written: &str, args: &[CallArg], scope: &Rc<Scope>, at: &Address, path: &str) -> Result<Binding, Stop> {
        let registered = self.registered_plugin(written, scope);
        let declared = self.plugin_spec(&registered).and_then(|spec| output_under(spec, self.version())).cloned();
        let Some(declared) = declared else {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{written}' declares no output, so there is nothing a call to it can hand back — the checker should have caught this"),
            )));
        };
        // From version 5 its arguments are by position, bound to its
        // parameters as the checker bound them.
        let bound = match self.plugin_spec(&registered) {
            Some(spec) if self.version() >= 5 && args.iter().any(|arg| arg.name().is_none()) => {
                let bound = spec.bind_args(PluginCallSite::Plain, args);
                if !bound.misfits.is_empty() {
                    let positional = spec.positional_params(PluginCallSite::Plain);
                    return Err(Stop::Thrown(Failure::engine(
                        "MOVENG_RUNTIME",
                        format!("{} — the checker should have caught this", bound.misfits[0].message(written, &positional)),
                    )));
                }
                Some(bound.args)
            }
            _ => None,
        };
        let args = bound.as_deref().unwrap_or(args);
        if args.first().is_some_and(|arg| arg.name().is_none()) {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{written}' is a plugin, and a plugin's arguments are named — the checker should have caught this"),
            )));
        }
        let mut config = JsObject::new();
        let mut origins: Vec<u32> = Vec::new();
        for (position, arg) in args.iter().enumerate() {
            let Some(name) = arg.name() else { continue };
            let (value, trail) = match arg {
                // A plugin's parameters are values: a write is an effect, and
                // a function or a type is no value yet.
                CallArg::Write { .. } | CallArg::Closure { .. } | CallArg::Type { .. } => {
                    let kind = match arg {
                        CallArg::Write { .. } => "write",
                        CallArg::Closure { .. } => "closure",
                        _ => "type",
                    };
                    return Err(Stop::Thrown(Failure::unsupported(
                        &format!("a {kind} argument to the plugin '{written}'"),
                        "a plugin takes values — pass a field or an expression",
                    )));
                }
                CallArg::Expr { expr, .. } => {
                    let evaluated = self.evaluate_slot(expr, scope).await?;
                    (evaluated.value, self.trail_of(&evaluated.prov, scope).unwrap_or_default())
                }
                // `pluginArgValue` over `evaluateCallArg`: a value with its
                // trail; a record as the binding it is, with none.
                CallArg::Call { .. } | CallArg::Node { .. } => {
                    let bound = self.plugin_bound_arg(arg, scope, at, &format!("{path}/args/{position}")).await?;
                    match bound {
                        Binding::Value(value) => (value.value, value.trail.unwrap_or_default()),
                        record => (Js::Record(Rc::new(record)), Trail::default()),
                    }
                }
            };
            // A record reaches only an argument that takes structured data:
            // what that takes is the record's fields (`recordFields`).
            let value = match crate::record::binding_of(&value) {
                Some(record) => Js::object(crate::record::fields_of(&record).map_err(|e| Stop::Thrown(Failure::of_eval(e, "")))?),
                None => value,
            };
            config.set(name.to_string(), value);
            for origin in trail.origins {
                if !origins.contains(&origin) {
                    origins.push(origin);
                }
            }
        }
        // What the plugin brought back is no longer justified by the quote
        // that pointed at it: the origins survive, the direct citation not.
        let trail = Trail { origins, direct: None };
        let started = self.clock_now().await.map_err(Stop::Thrown)?;
        let result = self.invoke(&registered, &config, &JsObject::new()).await.map_err(Stop::Thrown)?;
        let duration = self.clock_now().await.map_err(Stop::Thrown)? - started;
        let (binding, handed_back) = match declared {
            PluginOutput::Value { .. } => {
                let value = result.text().map_or(Js::Null, Js::str);
                let handed_back = !matches!(value, Js::Null);
                (Binding::Value(ValueBinding { value, trail: Some(trail), many: false }), handed_back)
            }
            PluginOutput::Record { .. } => {
                let mut fields = JsObject::new();
                if let Some(text) = result.text() {
                    fields.set(FETCHED_TEXT_FIELD.into(), Js::str(text));
                }
                // `Object.assign(fields, result.data)`: an own `__proto__`
                // key in the data sets the fields' prototype.
                if let Some(Js::Object(data)) = &result.data {
                    for (key, value) in data.entries() {
                        fields.assign(key.clone(), value.clone());
                    }
                }
                let field_order: Vec<String> = fields.entries().iter().map(|(k, _)| k.clone()).collect();
                let handed_back = !field_order.is_empty();
                let field_provenance = field_order.iter().map(|name| (name.clone(), trail.clone())).collect();
                let node = Node { fields, field_order, field_provenance, landed_on: None, edges: Vec::new() };
                (Binding::Node(Rc::new(RefCell::new(node))), handed_back)
            }
            // One record per thing the plugin found, in its order: the
            // landings a hop would give, so FIRST, MAP and a field read work
            // across them (`pluginCallBinding`). None found is the empty list.
            PluginOutput::Records { .. } => {
                if result.records_not_a_list {
                    return Err(Stop::Thrown(Failure::Engine {
                        class: crate::eval::ErrorClass::TypeError,
                        message: "(result.records ?? []).map is not a function".into(),
                    }));
                }
                let mut landings: Vec<Binding> = Vec::new();
                for record in &result.records {
                    let fields = spread_fields(record)?;
                    let field_order: Vec<String> = fields.entries().iter().map(|(k, _)| k.clone()).collect();
                    let field_provenance = field_order.iter().map(|name| (name.clone(), trail.clone())).collect();
                    landings.push(Binding::Node(Rc::new(RefCell::new(Node { fields, field_order, field_provenance, landed_on: None, edges: Vec::new() }))));
                }
                let handed_back = !landings.is_empty();
                (Binding::Positions(landings), handed_back)
            }
        };
        let mut entry = Members::default();
        entry.set("plugin", Js::str(registered.clone()));
        if let Some(Js::String(url)) = config.get("url") {
            entry.set("url", Js::str(crate::extract::emission::cut(url.as_form(), crate::extract::run::TRACE_URL_CHARS)));
        }
        entry.set("durationMs", Js::Number(duration));
        result.trace_into(&mut entry);
        entry.set("returned", Js::str(if handed_back { "value" } else { "absent" }));
        self.trace(TraceEntry::Plugin(entry));
        Ok(binding)
    }
}
