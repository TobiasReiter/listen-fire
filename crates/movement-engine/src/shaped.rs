//! A dict the TypeScript engine takes for a record of a system
//! (`bindingOf`: a `sourcePosition`, a write `handle`, an `instance`), read
//! off its graph as expression.ts and run.ts read the binding object: where
//! a walk starts and through which read. The dict is data — no `Map`, no
//! function, no class instance — so where the TypeScript would call into
//! what the dict holds (its `read`'s adapter), it throws V8's TypeError at
//! that point, and so does this.

use std::rc::Rc;

use crate::bindings::InstanceBinding;
use crate::eval::EvalError;
use crate::js::Js;
use crate::record::{get, type_error};
use crate::run::{Failure, Run};
use crate::traverse::Read;

/// The read a walk off a shaped record goes through: a graph this run reads
/// (the event's source, an instance resolved from the dict), or the dict's
/// own `read`, which holds no adapter that can be called.
#[derive(Clone)]
pub(crate) enum GraphRead {
    Live(Rc<Read>),
    Foreign(Js),
}

/// `read.adapter.<method>(…)` on a dict's `read`: V8's TypeError, read
/// off whatever `adapter` is (`variable` names the read as the TypeScript
/// source does).
pub(crate) fn foreign_call(read: &Js, variable: &str, method: &str) -> EvalError {
    match get(read, "adapter") {
        Err(error) => error,
        Ok(adapter) if adapter.is_nullish() => type_error(&format!("Cannot read properties of {} (reading '{method}')", adapter.to_js_string())),
        Ok(_) => type_error(&format!("{variable}.adapter.{method} is not a function")),
    }
}

/// `stepExistsCursor`'s hop through a dict's `read`: the incoming check,
/// `read.edgeFieldId?.(…)`, then `read.adapter.getRelated` (named before its
/// argument, whose pushdown asks `read.adapter.runtimeCapabilities()`).
pub(crate) fn foreign_related(read: &Js, incoming: bool) -> EvalError {
    if incoming {
        return foreign_call(read, "read", "runtimeCapabilities");
    }
    match get(read, "edgeFieldId") {
        Err(error) => return error,
        Ok(found) if !found.is_nullish() => return type_error("read.edgeFieldId is not a function"),
        Ok(_) => {}
    }
    match get(read, "adapter") {
        Err(error) => error,
        Ok(adapter) if adapter.is_nullish() => type_error(&format!("Cannot read properties of {} (reading 'getRelated')", adapter.to_js_string())),
        Ok(_) => type_error("read.adapter.runtimeCapabilities is not a function"),
    }
}

/// The read wrapper's reads of a position a dict supplies, before it asks
/// the adapter anything (kg.ts `surfaceReadAdapter`): its `recordType`, and,
/// where it restamps the position under a natural type, its identity's
/// `kind`.
pub(crate) fn wrapper_reads(position: &Js, start_surface_type: Option<&str>) -> Result<(), EvalError> {
    let record_type = get(position, "recordType")?;
    let natural = if record_type.is_nullish() { start_surface_type.map(Js::str) } else { Some(record_type.clone()) };
    if let Some(natural) = natural
        && !crate::js::strict_equals(&natural, &record_type)
    {
        get(&get(position, "identity")?, "kind")?;
    }
    Ok(())
}

fn eval(error: EvalError) -> Failure {
    Failure::of_eval(error, "")
}

impl Run<'_> {
    /// A `sourcePosition` dict's start and read: `binding.read ?? ctx.source`.
    pub(crate) fn shaped_source_record(&self, this: &Js) -> Result<(Js, GraphRead), Failure> {
        let position = get(this, "position").map_err(eval)?;
        let read = get(this, "read").map_err(eval)?;
        if read.is_nullish() {
            let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
            return Ok((position, GraphRead::Live(source.read.clone())));
        }
        Ok((position, GraphRead::Foreign(read)))
    }

    /// `handleRecord` of a `handle` dict (`graphReadFor`): its record in its
    /// graph, read through the dict's `graph.instance`.
    pub(crate) async fn shaped_handle_record(&self, this: &Js, name: &str) -> Result<(Js, GraphRead), Failure> {
        let handle = get(this, "handle").map_err(eval)?;
        let external_id = get(&handle, "externalId").map_err(eval)?;
        if matches!(external_id, Js::Undefined) {
            return Err(Failure::unsupported(&format!("traversing from a write handle ('{name}')"), "the handle bound no readable record to traverse from"));
        }
        let instance = get(&get(this, "graph").map_err(eval)?, "instance").map_err(eval)?;
        let read = self.shaped_instance_read(&instance).await?;
        let start = crate::traverse::stable_position(
            get(&handle, "adapterType").map_err(eval)?,
            get(this, "targetType").map_err(eval)?,
            external_id,
            get(&handle, "resultData").map_err(eval)?,
        );
        Ok((start, GraphRead::Live(read)))
    }

    /// `instanceSourceRead` of an `instance` dict: its adapter resolved as
    /// the TypeScript resolves it, from the dict's slug, credential name and
    /// construction config. A dict that would put into the host request what
    /// the host contract does not take (a slug or a name that is not text, a
    /// config that is not a map of texts) or that carries a schema of its
    /// own is this engine's refusal.
    pub(crate) async fn shaped_instance_read(&self, instance: &Js) -> Result<Rc<Read>, Failure> {
        let credential = get(instance, "credentialName").map_err(eval)?;
        let config = get(instance, "constructionConfig").map_err(eval)?;
        let slug = get(instance, "adapterSlug").map_err(eval)?;
        let name = get(instance, "name").map_err(eval)?;
        let schema = get(instance, "schema").map_err(eval)?;
        let beyond = |what: &str| Failure::unreproduced(&format!("reading through a value shaped like a constructed adapter instance whose {what}"), "the TypeScript engine asks its host for an adapter outside the host contract");
        let Js::String(slug) = slug else { return Err(beyond("adapter slug is not text")) };
        // Only what a read's origins cite (`instanceName`).
        let name = name.to_js_string();
        if !schema.is_nullish() {
            return Err(beyond("schema is its own"));
        }
        let construction_config = match config {
            Js::Undefined | Js::Null => Vec::new(),
            Js::Object(entries) => {
                let mut out = Vec::new();
                for (key, value) in entries.entries() {
                    let Js::String(value) = value else { return Err(beyond("construction config is not a map of texts")) };
                    out.push((key.clone(), value.clone()));
                }
                out
            }
            _ => return Err(beyond("construction config is not a map of texts")),
        };
        let credential_name = credential.truthy().then(|| credential.to_js_string());
        let binding = InstanceBinding { name, adapter_slug: slug, credential_name, construction_config, schema: None };
        self.instance_read(&binding).await
    }
}
