//! A plugin called plainly (run.ts `executePluginCall`): `page =
//! fetch_url(url: c.website)`, `x = p()`, or `p(…)` as a statement. Its named
//! arguments are evaluated in the order written and handed to the plugin as
//! its config; the invocation is timed (`clock.now` either side), refused
//! before the host is asked when the plugin is priced and the cap is spent,
//! and traced; what comes back is bound as the plugin's DECLARED output under
//! the movement's pin (`pluginOutputUnder`): a `value` output its text, a
//! `record` output a node of the fields it attached (its text under `text`).
//! A `records` output is refused at admission.

use std::cell::RefCell;
use std::rc::Rc;

use movement_parser::catalog::types::{JsMap, PluginOutput, PluginSpec};

use crate::bindings::{Binding, Node, Scope};
use crate::env::{Trail, ValueBinding};
use crate::js::{Js, JsObject};
use crate::run::{Failure, Run, Stop};
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

impl Run<'_> {
    /// `executePluginCall`: `args` are the call's named arguments, in the
    /// order written.
    pub(crate) async fn plugin_call(&self, written: &str, args: &[(String, movement_parser::ast::ExprSlot)], scope: &Rc<Scope>) -> Result<Binding, Stop> {
        let registered = self.registered_plugin(written, scope);
        let declared = self.plugin_spec(&registered).and_then(|spec| output_under(spec, self.version())).cloned();
        let Some(declared) = declared else {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("'{written}' declares no output, so there is nothing a call to it can hand back — the checker should have caught this"),
            )));
        };
        if let PluginOutput::Records { .. } = declared {
            return Err(Stop::Thrown(Failure::unreproduced(
                &format!("binding what '{written}' fetched as records"),
                "the Rust engine binds a plugin's value or record output",
            )));
        }
        let mut config = JsObject::new();
        let mut origins: Vec<u32> = Vec::new();
        for (name, slot) in args {
            let evaluated = self.evaluate_slot(slot, scope).await?;
            let trail = self.trail_of(&evaluated.prov, scope).unwrap_or_default();
            // A record reaches only an argument that takes structured data:
            // what that takes is the record's fields (`recordFields`).
            let value = match crate::record::binding_of(&evaluated.value) {
                Some(record) => Js::object(crate::record::fields_of(&record).map_err(|e| Stop::Thrown(Failure::of_eval(e, "")))?),
                None => evaluated.value,
            };
            config.set(name.clone(), value);
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
                if let Some(Js::Object(data)) = &result.data {
                    for (key, value) in data.entries() {
                        fields.set(key.clone(), value.clone());
                    }
                }
                let field_order: Vec<String> = fields.entries().iter().map(|(k, _)| k.clone()).collect();
                let handed_back = !field_order.is_empty();
                let field_provenance = field_order.iter().map(|name| (name.clone(), trail.clone())).collect();
                let node = Node { fields, field_order, field_provenance, landed_on: None, edges: Vec::new() };
                (Binding::Node(Rc::new(RefCell::new(node))), handed_back)
            }
            PluginOutput::Records { .. } => unreachable!("refused before the invocation"),
        };
        let mut entry = Members::default();
        entry.set("plugin", Js::str(registered.clone()));
        if let Some(Js::String(url)) = config.get("url") {
            entry.set("url", Js::str(crate::extract::emission::cut(url, crate::extract::run::TRACE_URL_CHARS)));
        }
        entry.set("durationMs", Js::Number(duration));
        result.trace_into(&mut entry);
        entry.set("returned", Js::str(if handed_back { "value" } else { "absent" }));
        self.trace(TraceEntry::Plugin(entry));
        Ok(binding)
    }
}
