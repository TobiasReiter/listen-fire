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
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

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
    /// Who to wake when a request in flight is answered: the future that
    /// awaits it, as the waker it was last polled with.
    wakers: BTreeMap<u32, Waker>,
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

    fn take_answer(&self, id: u32, waker: &Waker) -> Option<Answer> {
        let mut table = self.table.borrow_mut();
        match table.slots.remove(&id) {
            Some(Slot::Answered(answer)) => {
                table.wakers.remove(&id);
                Some(answer)
            }
            Some(other) => {
                table.slots.insert(id, other);
                table.wakers.insert(id, waker.clone());
                None
            }
            None => unreachable!("request {id} vanished while its future was alive"),
        }
    }

    fn abandon(&self, id: u32) {
        let mut table = self.table.borrow_mut();
        table.wakers.remove(&id);
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
                let waker = table.wakers.remove(&id);
                drop(table);
                if let Some(waker) = waker {
                    waker.wake();
                }
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

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Answer> {
        // `HostCall` holds no self-references, so it is `Unpin`.
        let this = self.get_mut();
        match std::mem::replace(&mut this.state, CallState::Finished) {
            CallState::Unissued(request) => {
                let id = this.host.issue(request);
                this.host.table.borrow_mut().wakers.insert(id, cx.waker().clone());
                this.state = CallState::Issued(id);
                Poll::Pending
            }
            CallState::Issued(id) => match this.host.take_answer(id, cx.waker()) {
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
/// back in input order whatever order the answers arrived in. After the
/// first poll a future is polled only when it is woken (its answer arrived),
/// so an answer costs one poll however many futures are in flight.
pub async fn join_all<F: Future>(futures: Vec<F>) -> Vec<F::Output> {
    let ready = Arc::new(ReadySet::default());
    let wakers = (0..futures.len()).map(|index| Waker::from(Arc::new(ChildWaker { index, ready: ready.clone() }))).collect();
    JoinAll { futures: futures.into_iter().map(|f| Joined::Running(Box::pin(f))).collect(), wakers, ready, started: false }.await
}

/// `job` over `items`, at most `width` at a time, each worker taking the next
/// item as it finishes one (fans.ts `mapConcurrent`): answered in the order
/// the items were written however they landed. The first failure stops the
/// fan starting anything further; once the items in flight have finished,
/// the earliest failing item's error is the fan's.
pub async fn map_concurrent<T, R, E, F, Fut>(items: Vec<T>, width: usize, job: F) -> Result<Vec<R>, E>
where
    F: Fn(T, usize) -> Fut,
    Fut: Future<Output = Result<R, E>>,
{
    let count = items.len();
    let queue = RefCell::new(items.into_iter().enumerate().collect::<std::collections::VecDeque<_>>());
    let results: RefCell<Vec<Option<R>>> = RefCell::new((0..count).map(|_| None).collect());
    let failures: RefCell<Vec<(usize, E)>> = RefCell::new(Vec::new());
    let worker = || async {
        while failures.borrow().is_empty() {
            let Some((index, item)) = queue.borrow_mut().pop_front() else { return };
            match job(item, index).await {
                Ok(result) => results.borrow_mut()[index] = Some(result),
                Err(error) => failures.borrow_mut().push((index, error)),
            }
        }
    };
    join_all((0..width.min(count)).map(|_| worker()).collect()).await;
    let mut failures = failures.into_inner();
    if !failures.is_empty() {
        failures.sort_by_key(|(index, _)| *index);
        return Err(failures.remove(0).1);
    }
    Ok(results.into_inner().into_iter().map(|r| r.expect("every item ran when none failed")).collect())
}

enum Joined<F: Future> {
    Running(Pin<Box<F>>),
    Done(Option<F::Output>),
}

struct JoinAll<F: Future> {
    futures: Vec<Joined<F>>,
    /// One per future: waking it marks that future due and wakes the join.
    wakers: Vec<Waker>,
    ready: Arc<ReadySet>,
    started: bool,
}

/// The futures of one join woken since its last poll, and the join's own
/// waker. A segment is single-threaded; the locks are what `Waker` asks of
/// state it shares.
#[derive(Default)]
struct ReadySet {
    woken: Mutex<Vec<usize>>,
    parent: Mutex<Option<Waker>>,
}

struct ChildWaker {
    index: usize,
    ready: Arc<ReadySet>,
}

impl Wake for ChildWaker {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.ready.woken.lock().expect("a segment is single-threaded").push(self.index);
        if let Some(parent) = self.ready.parent.lock().expect("a segment is single-threaded").as_ref() {
            parent.wake_by_ref();
        }
    }
}

// The futures are boxed and the outputs are only ever moved out whole, so
// nothing in a `JoinAll` is pinned in place.
impl<F: Future> Unpin for JoinAll<F> {}

impl<F: Future> Future for JoinAll<F> {
    type Output = Vec<F::Output>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        *this.ready.parent.lock().expect("a segment is single-threaded") = Some(cx.waker().clone());
        let due: Vec<usize> = if std::mem::replace(&mut this.started, true) {
            let mut woken = std::mem::take(&mut *this.ready.woken.lock().expect("a segment is single-threaded"));
            woken.sort_unstable();
            woken.dedup();
            woken
        } else {
            (0..this.futures.len()).collect()
        };
        for index in due {
            if let Joined::Running(future) = &mut this.futures[index]
                && let Poll::Ready(output) = future.as_mut().poll(&mut Context::from_waker(&this.wakers[index]))
            {
                this.futures[index] = Joined::Done(Some(output));
            }
        }
        // A future woken while this pass ran is polled on the next.
        if !this.ready.woken.lock().expect("a segment is single-threaded").is_empty() {
            cx.waker().wake_by_ref();
        }
        if this.futures.iter().any(|joined| matches!(joined, Joined::Running(_))) {
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

    /// At most `width` items in flight, the next started as one finishes,
    /// the answers in the items' order; the earliest failing item's error is
    /// the fan's, once what was in flight has finished, and nothing further
    /// starts after a failure.
    #[test]
    fn a_bounded_fan_keeps_its_width_and_answers_in_order() {
        let mut segment = Segment::new(|host| async move {
            let fanned = map_concurrent(vec!["a", "b", "c"], 2, |item, _| {
                let host = host.clone();
                async move { echo(&host, item).await.map(|answer| answer.unwrap_or(Json::Null)).map_err(|e| e.message().to_string()) }
            })
            .await;
            json!(fanned)
        });
        let sent = pending(segment.start().unwrap());
        assert_eq!(sent.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        let next = pending(segment.answer(2, Ok(Some(json!("B")))).unwrap());
        assert_eq!(next.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["c"]);
        assert_eq!(segment.answer(3, Ok(Some(json!("C")))).unwrap(), Step::Pending(vec![]));
        assert_eq!(segment.answer(1, Ok(Some(json!("A")))).unwrap(), Step::Done(json!({ "Ok": ["A", "B", "C"] })));

        let mut failing = Segment::new(|host| async move {
            let fanned = map_concurrent(vec!["a", "b", "c"], 2, |item, _| {
                let host = host.clone();
                async move { echo(&host, item).await.map(|answer| answer.unwrap_or(Json::Null)).map_err(|e| e.message().to_string()) }
            })
            .await;
            json!(fanned)
        });
        pending(failing.start().unwrap());
        // `b` fails: `c` never starts, and `a`, still in flight, finishes first.
        assert_eq!(failing.answer(2, Err(HostError { detail: json!({ "message": "b failed" }) })).unwrap(), Step::Pending(vec![]));
        assert_eq!(failing.answer(1, Err(HostError { detail: json!({ "message": "a failed" }) })).unwrap(), Step::Done(json!({ "Err": "a failed" })));
    }

    /// 2,000 reads in flight, answered last first: each read is polled when
    /// it starts and when its answer arrives, never on another's answer.
    #[test]
    fn a_join_polls_only_the_futures_an_answer_woke() {
        const N: usize = 2_000;
        let polls = Rc::new(std::cell::Cell::new(0usize));
        let counted = polls.clone();
        let mut segment = Segment::new(move |host| async move {
            let reads = (0..N)
                .map(|i| {
                    let mut call = echo(&host, &format!("r{i}"));
                    let polls = counted.clone();
                    std::future::poll_fn(move |cx| {
                        polls.set(polls.get() + 1);
                        Pin::new(&mut call).poll(cx)
                    })
                })
                .collect();
            json!(join_all(reads).await.len())
        });
        let sent = pending(segment.start().unwrap());
        assert_eq!(sent.len(), N);
        let mut done = None;
        for request in sent.iter().rev() {
            if let Step::Done(result) = segment.answer(request.id, Ok(None)).unwrap() {
                done = Some(result);
            }
        }
        assert_eq!(done, Some(json!(N)));
        // Polling every future on every answer would be N²/2, two million.
        assert_eq!(polls.get(), 2 * N);
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
