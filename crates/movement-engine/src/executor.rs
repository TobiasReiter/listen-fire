//! A single-threaded async runtime for one segment. The segment is one
//! future; everything it needs from the world it asks the host for, through
//! a `HostCall` future that records `{id, family, method, args}` in the
//! pending table and yields. The TypeScript shim answers each request by id,
//! in any order, and the segment is polled again after every answer. No
//! waker is needed: nothing but an answer can make progress possible, so
//! "poll after each answer" is the whole scheduler.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use serde::Serialize;
use serde_json::Value as Json;

use crate::host::Request;

/// What a request the host could not serve resolves to: the error object it
/// answered with, which carries at least `message`.
#[derive(Debug, Clone, PartialEq)]
pub struct HostError {
    pub detail: Json,
}

impl HostError {
    pub fn message(&self) -> &str {
        self.detail.get("message").and_then(Json::as_str).unwrap_or("")
    }
}

/// A served request's value, `None` when the host's answer was `undefined`.
pub type Answer = Result<Option<Json>, HostError>;

/// One request as the shim receives it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PendingRequest {
    pub id: u32,
    pub family: &'static str,
    pub method: String,
    pub args: Json,
}

/// What a segment hands back after `start` or an answer. `Pending` lists only
/// the requests issued since the previous step: the ones listed before are
/// still awaited, so an empty list means "waiting on requests already in
/// flight".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    Pending(Vec<PendingRequest>),
    Done(Json),
}

/// A misuse of the protocol, never a run's own failure (which is a value the
/// segment returns in `done`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolError(pub String);

enum Slot {
    /// Issued, not yet handed to the shim.
    Unsent(PendingRequest),
    /// Handed to the shim, not yet answered.
    InFlight,
    Answered(Answer),
    /// Its future was dropped (a race's loser) while in flight: the answer
    /// is still accepted, and discarded.
    Abandoned,
}

#[derive(Default)]
struct Table {
    next_id: u32,
    slots: BTreeMap<u32, Slot>,
}

/// The segment's handle on the host: every request goes through it.
#[derive(Clone, Default)]
pub struct Host {
    table: Rc<RefCell<Table>>,
}

impl Host {
    pub fn request(&self, request: Request) -> HostCall {
        HostCall { host: self.clone(), state: CallState::Unissued(request) }
    }

    fn issue(&self, request: Request) -> u32 {
        let mut table = self.table.borrow_mut();
        table.next_id += 1;
        let id = table.next_id;
        let pending = PendingRequest { id, family: request.family.as_str(), method: request.method, args: request.args };
        table.slots.insert(id, Slot::Unsent(pending));
        id
    }

    fn take_answer(&self, id: u32) -> Option<Answer> {
        let mut table = self.table.borrow_mut();
        match table.slots.remove(&id) {
            Some(Slot::Answered(answer)) => Some(answer),
            Some(other) => {
                table.slots.insert(id, other);
                None
            }
            None => unreachable!("request {id} vanished while its future was alive"),
        }
    }

    fn abandon(&self, id: u32) {
        let mut table = self.table.borrow_mut();
        match table.slots.remove(&id) {
            // Never seen by the shim, so nothing will answer it.
            Some(Slot::Unsent(_)) | Some(Slot::Answered(_)) | None => {}
            Some(Slot::InFlight) | Some(Slot::Abandoned) => {
                table.slots.insert(id, Slot::Abandoned);
            }
        }
    }

    fn answer(&self, id: u32, answer: Answer) -> Result<(), ProtocolError> {
        let mut table = self.table.borrow_mut();
        match table.slots.get(&id) {
            Some(Slot::InFlight) => {
                table.slots.insert(id, Slot::Answered(answer));
                Ok(())
            }
            Some(Slot::Abandoned) => {
                table.slots.remove(&id);
                Ok(())
            }
            Some(Slot::Answered(_)) => Err(ProtocolError(format!("request {id} was answered twice"))),
            Some(Slot::Unsent(_)) => Err(ProtocolError(format!("request {id} was answered before it was sent"))),
            None if id >= 1 && id <= table.next_id => Err(ProtocolError(format!("request {id} was answered twice"))),
            None => Err(ProtocolError(format!("no request {id} was made"))),
        }
    }

    /// Moves every issued request to in flight, in issue order.
    fn drain_unsent(&self) -> Vec<PendingRequest> {
        let mut table = self.table.borrow_mut();
        let mut sent = Vec::new();
        for slot in table.slots.values_mut() {
            if let Slot::Unsent(_) = slot {
                let Slot::Unsent(request) = std::mem::replace(slot, Slot::InFlight) else { unreachable!() };
                sent.push(request);
            }
        }
        sent
    }

    /// Whether anything is still awaited: an answer can still arrive that a
    /// live future will read.
    fn awaits_anything(&self) -> bool {
        self.table.borrow().slots.values().any(|slot| matches!(slot, Slot::InFlight | Slot::Answered(_)))
    }
}

enum CallState {
    Unissued(Request),
    Issued(u32),
    Finished,
}

/// One host request: issued on its first poll, ready once answered.
pub struct HostCall {
    host: Host,
    state: CallState,
}

impl Future for HostCall {
    type Output = Answer;

    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Answer> {
        // `HostCall` holds no self-references, so it is `Unpin`.
        let this = self.get_mut();
        match std::mem::replace(&mut this.state, CallState::Finished) {
            CallState::Unissued(request) => {
                this.state = CallState::Issued(this.host.issue(request));
                Poll::Pending
            }
            CallState::Issued(id) => match this.host.take_answer(id) {
                Some(answer) => Poll::Ready(answer),
                None => {
                    this.state = CallState::Issued(id);
                    Poll::Pending
                }
            },
            CallState::Finished => panic!("a host call was polled after it completed"),
        }
    }
}

impl Drop for HostCall {
    fn drop(&mut self) {
        if let CallState::Issued(id) = self.state {
            self.host.abandon(id);
        }
    }
}

type Task = Pin<Box<dyn Future<Output = Json>>>;

/// One segment: its task and the host table its requests live in. Dropping
/// it drops every future, which is all `finish` does.
pub struct Segment {
    host: Host,
    task: Option<Task>,
}

impl Segment {
    /// Builds the task from the host handle; nothing runs until `start`.
    pub fn new<F, Fut>(task: F) -> Segment
    where
        F: FnOnce(Host) -> Fut,
        Fut: Future<Output = Json> + 'static,
    {
        let host = Host::default();
        let task: Task = Box::pin(task(host.clone()));
        Segment { host, task: Some(task) }
    }

    pub fn start(&mut self) -> Result<Step, ProtocolError> {
        self.poll()
    }

    pub fn answer(&mut self, id: u32, answer: Answer) -> Result<Step, ProtocolError> {
        if self.task.is_none() {
            return Err(ProtocolError(format!("request {id} was answered after the segment finished")));
        }
        self.host.answer(id, answer)?;
        self.poll()
    }

    fn poll(&mut self) -> Result<Step, ProtocolError> {
        let Some(task) = self.task.as_mut() else {
            return Err(ProtocolError("the segment has already finished".into()));
        };
        let mut cx = Context::from_waker(Waker::noop());
        match task.as_mut().poll(&mut cx) {
            Poll::Ready(result) => {
                // The task's futures are gone; answers to anything it left in
                // flight are protocol errors from here on.
                self.task = None;
                Ok(Step::Done(result))
            }
            Poll::Pending => {
                let sent = self.host.drain_unsent();
                if sent.is_empty() && !self.host.awaits_anything() {
                    return Err(ProtocolError("the segment is waiting on nothing: it can never finish".into()));
                }
                Ok(Step::Pending(sent))
            }
        }
    }
}

/// A future that asks nothing of the host, run to its end on the spot: an
/// evaluation with no reader, a predicate whose comparator answers itself.
/// Polled once; waiting on anything would be a bug in the caller.
pub fn ready<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("a future that asks nothing of the host waited"),
    }
}

/// Every future to completion, polled together, so their host requests are
/// in flight at once (the TypeScript engine's `Promise.all`). Outputs come
/// back in input order whatever order the answers arrived in.
pub async fn join_all<F: Future>(futures: Vec<F>) -> Vec<F::Output> {
    JoinAll { futures: futures.into_iter().map(|f| Joined::Running(Box::pin(f))).collect() }.await
}

enum Joined<F: Future> {
    Running(Pin<Box<F>>),
    Done(Option<F::Output>),
}

struct JoinAll<F: Future> {
    futures: Vec<Joined<F>>,
}

// The futures are boxed and the outputs are only ever moved out whole, so
// nothing in a `JoinAll` is pinned in place.
impl<F: Future> Unpin for JoinAll<F> {}

impl<F: Future> Future for JoinAll<F> {
    type Output = Vec<F::Output>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let mut all_done = true;
        for joined in &mut this.futures {
            if let Joined::Running(future) = joined {
                match future.as_mut().poll(cx) {
                    Poll::Ready(output) => *joined = Joined::Done(Some(output)),
                    Poll::Pending => all_done = false,
                }
            }
        }
        if !all_done {
            return Poll::Pending;
        }
        Poll::Ready(
            this.futures
                .iter_mut()
                .map(|joined| match joined {
                    Joined::Done(output) => output.take().expect("each output is taken once"),
                    Joined::Running(_) => unreachable!("every future finished"),
                })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::host::{Family, Request};

    fn echo(host: &Host, method: &str) -> HostCall {
        host.request(Request { family: Family::Echo, method: method.into(), args: json!({ "m": method }) })
    }

    fn pending(step: Step) -> Vec<PendingRequest> {
        match step {
            Step::Pending(requests) => requests,
            Step::Done(result) => panic!("expected pending, got done {result}"),
        }
    }

    #[test]
    fn two_requests_pending_at_once_answered_out_of_order() {
        let mut segment = Segment::new(|host| async move {
            let answers = join_all(vec![echo(&host, "a"), echo(&host, "b")]).await;
            json!(answers.into_iter().map(|a| a.unwrap()).collect::<Vec<_>>())
        });
        let sent = pending(segment.start().unwrap());
        assert_eq!(sent.iter().map(|r| (r.id, r.method.as_str())).collect::<Vec<_>>(), vec![(1, "a"), (2, "b")]);
        assert_eq!(sent[0].family, "echo");
        assert_eq!(sent[0].args, json!({ "m": "a" }));
        // The later request first: nothing new is issued, the first is still awaited.
        assert_eq!(segment.answer(2, Ok(Some(json!("B")))).unwrap(), Step::Pending(vec![]));
        assert_eq!(segment.answer(1, Ok(None)).unwrap(), Step::Done(json!([null, "B"])));
    }

    #[test]
    fn an_error_answer_is_an_err_the_task_handles() {
        let mut segment = Segment::new(|host| async move {
            match echo(&host, "fails").await {
                Ok(_) => json!("unexpected"),
                Err(error) => json!({ "handled": error.message() }),
            }
        });
        let sent = pending(segment.start().unwrap());
        let step = segment.answer(sent[0].id, Err(HostError { detail: json!({ "message": "adapter down" }) })).unwrap();
        assert_eq!(step, Step::Done(json!({ "handled": "adapter down" })));
    }

    #[test]
    fn a_task_with_no_requests_is_done_at_start() {
        let mut segment = Segment::new(|_host| async { json!({ "ok": true }) });
        assert_eq!(segment.start().unwrap(), Step::Done(json!({ "ok": true })));
        assert_eq!(segment.start(), Err(ProtocolError("the segment has already finished".into())));
    }

    #[test]
    fn sequential_requests_are_issued_one_step_at_a_time() {
        let mut segment = Segment::new(|host| async move {
            let first = echo(&host, "first").await.unwrap();
            let second = echo(&host, "second").await.unwrap();
            json!([first, second])
        });
        assert_eq!(pending(segment.start().unwrap())[0].method, "first");
        let next = pending(segment.answer(1, Ok(Some(json!(1)))).unwrap());
        assert_eq!((next[0].id, next[0].method.as_str()), (2, "second"));
        assert_eq!(segment.answer(2, Ok(Some(json!(2)))).unwrap(), Step::Done(json!([1, 2])));
    }

    #[test]
    fn protocol_misuse_is_refused() {
        let mut segment = Segment::new(|host| async move {
            let _ = join_all(vec![echo(&host, "a"), echo(&host, "b")]).await;
            json!(null)
        });
        segment.start().unwrap();
        assert_eq!(segment.answer(9, Ok(None)), Err(ProtocolError("no request 9 was made".into())));
        segment.answer(1, Ok(None)).unwrap();
        assert_eq!(segment.answer(1, Ok(None)), Err(ProtocolError("request 1 was answered twice".into())));
        assert_eq!(segment.answer(2, Ok(None)).unwrap(), Step::Done(json!(null)));
        assert_eq!(
            segment.answer(2, Ok(None)),
            Err(ProtocolError("request 2 was answered after the segment finished".into()))
        );
    }

    #[test]
    fn a_dropped_request_s_late_answer_is_discarded() {
        // A race: the first answer wins and the loser's future is dropped.
        let mut segment = Segment::new(|host| async move {
            let mut a = echo(&host, "a");
            let mut b = echo(&host, "b");
            let winner = std::future::poll_fn(|cx| {
                if let Poll::Ready(v) = Pin::new(&mut a).poll(cx) {
                    return Poll::Ready(("a", v));
                }
                Pin::new(&mut b).poll(cx).map(|v| ("b", v))
            })
            .await;
            drop((a, b));
            // Proves the segment keeps going after the late answer arrives.
            let after = echo(&host, "after").await.unwrap();
            json!([winner.0, after])
        });
        assert_eq!(pending(segment.start().unwrap()).len(), 2);
        let next = pending(segment.answer(2, Ok(Some(json!("b")))).unwrap());
        assert_eq!(next[0].method, "after");
        assert_eq!(segment.answer(1, Ok(Some(json!("late")))).unwrap(), Step::Pending(vec![]));
        assert_eq!(segment.answer(3, Ok(Some(json!("x")))).unwrap(), Step::Done(json!(["b", "x"])));
    }

    #[test]
    fn a_task_waiting_on_nothing_is_a_protocol_error() {
        let mut segment = Segment::new(|_host| async {
            std::future::pending::<()>().await;
            json!(null)
        });
        assert_eq!(
            segment.start(),
            Err(ProtocolError("the segment is waiting on nothing: it can never finish".into()))
        );
    }
}
