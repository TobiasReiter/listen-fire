//! Flows that run at once inside one segment: a `parallel`'s or a `race`'s
//! arms, a collection op's members. run.ts keeps the state that differs per
//! flow in a `FlowFrame` and in async-local stores (the statement being run,
//! the body boundaries the flow is inside, the effect locks it holds); here
//! the run holds the running flow's copy of each, and a flow's future swaps
//! its own in for every poll and back out after (`InFlow`). The executor is
//! single-threaded and polls one future at a time, so the run's copy is
//! always the copy of the flow that is running.
//!
//! What flows do to the world is kept apart by the run's effect locks
//! (effect_locks.ts, `Gate`): an identity write's keys, the record an update
//! changes, the edge a link asserts. And their writes are ordered by program
//! position and branch, never by when they landed (write_ledger.ts,
//! `WriteOrder`).

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use crate::bindings::{Binding, Scope};
use crate::run::{Address, Run};
use crate::trace::TraceEntry;

// ── The write ledger's order (write_ledger.ts) ──

/// Where a flow's next write falls in program order: its own place (empty
/// for the segment's main flow; for a branch, its parent's place, the
/// fork's position in the parent and its branch index), and the position
/// its next write or fork takes.
#[derive(Debug, Clone, Default)]
pub(crate) struct WriteOrder {
    pub prefix: Vec<usize>,
    pub next: usize,
}

impl WriteOrder {
    /// The key the next write takes (`WriteLedger.append`).
    pub fn key(&mut self) -> Vec<usize> {
        let mut key = self.prefix.clone();
        key.push(self.next);
        self.next += 1;
        key
    }

    /// `forkWriteOrder`: a fork's position reserved; each branch it starts
    /// takes its order from it, by branch index.
    pub fn fork(&mut self) -> Fork {
        let at = self.next;
        self.next += 1;
        Fork { prefix: self.prefix.clone(), at }
    }
}

/// A fork's place in its parent's order.
#[derive(Debug, Clone)]
pub(crate) struct Fork {
    prefix: Vec<usize>,
    at: usize,
}

impl Fork {
    pub fn branch(&self, index: usize) -> WriteOrder {
        let mut prefix = self.prefix.clone();
        prefix.extend([self.at, index]);
        WriteOrder { prefix, next: 0 }
    }
}

/// `compareKeys`: a key before every key it is a prefix of.
pub(crate) fn compare_keys(a: &[usize], b: &[usize]) -> std::cmp::Ordering {
    for (x, y) in a.iter().zip(b) {
        if x != y {
            return x.cmp(y);
        }
    }
    a.len().cmp(&b.len())
}

// ── A statement as the site of its calls (run.ts `StatementSite`) ──

/// What one finished call handed back, and the statement's call count after
/// it (its arguments' own calls included): `CallRecord`.
#[derive(Debug, Clone)]
pub(crate) struct CallRecord {
    pub value: Option<Binding>,
    pub next: usize,
}

/// The calls one statement has made, in order (`StatementCalls`): the next
/// one's index, those finished, and on a re-run those that had already
/// finished before a park, handed back instead of made again.
#[derive(Debug, Default)]
pub(crate) struct Calls {
    pub next: usize,
    pub completed: Vec<(usize, CallRecord)>,
    pub replay: Vec<(usize, CallRecord)>,
}

impl Calls {
    pub fn complete(&mut self, index: usize, record: CallRecord) {
        match self.completed.iter_mut().find(|(i, _)| *i == index) {
            Some(slot) => slot.1 = record,
            None => self.completed.push((index, record)),
        }
    }

    /// Every call handed back, the ones a re-run had still to replay among
    /// them, by index (`new Map([...replay, ...completed])`, sorted).
    pub fn journal(&self) -> Vec<(usize, CallRecord)> {
        let mut all: Vec<(usize, CallRecord)> = self.replay.clone();
        for (index, record) in &self.completed {
            match all.iter_mut().find(|(i, _)| i == index) {
                Some(slot) => slot.1 = record.clone(),
                None => all.push((*index, record.clone())),
            }
        }
        all.sort_by_key(|(index, _)| *index);
        all
    }

    /// The finished calls alone, by index.
    pub fn finished(&self) -> Vec<(usize, CallRecord)> {
        let mut all = self.completed.clone();
        all.sort_by_key(|(index, _)| *index);
        all
    }
}

/// The statement running in a flow: its address, the scope it runs in
/// (what a park inside one of its calls writes as the caller's, and what a
/// re-run of it runs in again) and its calls.
#[derive(Debug)]
pub(crate) struct Site {
    pub address: Address,
    pub scope: Rc<Scope>,
    pub calls: RefCell<Calls>,
}

impl Site {
    pub fn new(address: Address, scope: Rc<Scope>, replay: Vec<(usize, CallRecord)>) -> Rc<Site> {
        Rc::new(Site { address, scope, calls: RefCell::new(Calls { next: 0, completed: Vec::new(), replay }) })
    }
}

// ── The body boundaries a flow is inside (run.ts `LiveBoundary`) ──

/// AST the program holds, as the TypeScript's park writes it: the node
/// itself, and where it sits in the program's tree (crate::program `File`),
/// whose JSON (keys sorted, as the parser emits them, the checker's stamps
/// after) is what a park stores.
#[derive(Debug, Clone)]
pub struct Code<T> {
    pub ast: Rc<T>,
    pub path: String,
}

/// A body boundary the running flow is inside: pushed as it crosses into a
/// called body, a collection op's member or an arm built at run time, so a
/// park below says how to get back (a `SerializedFrame` once written).
#[derive(Debug, Clone)]
pub(crate) enum Boundary {
    Call { site: Rc<Site>, index: usize, next: usize, callee: String },
    Member { site: Rc<Site>, index: usize, next: usize, member: usize, op: Rc<movement_parser::ast::CollectionOpExpression> },
    Arm { arm: usize, body: Code<movement_parser::ast::ClosureExpression> },
}

// ── The run's effect locks (effect_locks.ts) ──

/// How a flow holds a lock: on its own, or alongside every other flow
/// holding it for the same group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LockMode {
    Exclusive,
    Shared(String),
}

/// `LockRequest`: a name, a mode, and whether only this run takes it (an
/// identity write's per-key locks, which the cross-run record-type lock
/// already covers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LockRequest {
    pub name: String,
    pub mode: LockMode,
    pub in_run_only: bool,
}

impl LockRequest {
    pub fn exclusive(name: String) -> LockRequest {
        LockRequest { name, mode: LockMode::Exclusive, in_run_only: false }
    }
}

fn compatible(held: &LockMode, wanted: &LockMode) -> bool {
    matches!((held, wanted), (LockMode::Shared(a), LockMode::Shared(b)) if a == b)
}

/// One flow waiting for a lock.
struct Waiter {
    mode: LockMode,
    granted: Rc<Cell<bool>>,
    waker: Rc<RefCell<Option<Waker>>>,
}

/// One lock (`Gate`). First come, first served: a flow that could join the
/// current holders still waits behind anyone already waiting.
#[derive(Default)]
pub(crate) struct Gate {
    holders: Cell<usize>,
    holding: RefCell<Option<LockMode>>,
    waiting: RefCell<VecDeque<Waiter>>,
}

impl Gate {
    /// Resolves once the lock is held.
    pub fn acquire(self: &Rc<Self>, mode: LockMode) -> Acquire {
        let free = self.holders.get() == 0 || self.holding.borrow().as_ref().is_some_and(|held| compatible(held, &mode));
        if free && self.waiting.borrow().is_empty() {
            self.take(mode);
            return Acquire { granted: Rc::new(Cell::new(true)), waker: Rc::new(RefCell::new(None)) };
        }
        let granted = Rc::new(Cell::new(false));
        let waker = Rc::new(RefCell::new(None));
        self.waiting.borrow_mut().push_back(Waiter { mode, granted: granted.clone(), waker: waker.clone() });
        Acquire { granted, waker }
    }

    pub fn release(&self) {
        self.holders.set(self.holders.get() - 1);
        if self.holders.get() > 0 {
            return;
        }
        *self.holding.borrow_mut() = None;
        loop {
            let next = {
                let waiting = self.waiting.borrow();
                let Some(next) = waiting.front() else { break };
                if self.holding.borrow().as_ref().is_some_and(|held| !compatible(held, &next.mode)) {
                    break;
                }
                next.mode.clone()
            };
            let Some(waiter) = self.waiting.borrow_mut().pop_front() else { break };
            self.take(next);
            waiter.granted.set(true);
            let waker = waiter.waker.borrow_mut().take();
            if let Some(waker) = waker {
                waker.wake();
            }
        }
    }

    pub fn idle(&self) -> bool {
        self.holders.get() == 0 && self.waiting.borrow().is_empty()
    }

    fn take(&self, mode: LockMode) {
        self.holders.set(self.holders.get() + 1);
        *self.holding.borrow_mut() = Some(mode);
    }
}

/// A gate's grant, awaited.
pub(crate) struct Acquire {
    granted: Rc<Cell<bool>>,
    waker: Rc<RefCell<Option<Waker>>>,
}

impl Future for Acquire {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.granted.get() {
            return Poll::Ready(());
        }
        *self.waker.borrow_mut() = Some(cx.waker().clone());
        Poll::Pending
    }
}

/// `canonicalRequests`: one request per name, in name order; two asks for
/// one name in different modes become one exclusive ask, and a name any ask
/// takes across runs is taken across runs.
pub(crate) fn canonical_requests(requests: Vec<LockRequest>) -> Vec<LockRequest> {
    let mut by_name: Vec<LockRequest> = Vec::new();
    for request in requests {
        match by_name.iter_mut().find(|r| r.name == request.name) {
            None => by_name.push(request),
            Some(already) => {
                let mode = if compatible(&already.mode, &request.mode) { request.mode } else { LockMode::Exclusive };
                already.mode = mode;
                already.in_run_only = already.in_run_only && request.in_run_only;
            }
        }
    }
    by_name.sort_by(|a, b| a.name.cmp(&b.name));
    by_name
}

/// `crossRunNames`: the names the segment's cross-run holder takes, one per
/// name, sorted.
pub(crate) fn cross_run_names(requests: &[LockRequest]) -> Vec<String> {
    let mut names: Vec<String> = requests.iter().filter(|r| !r.in_run_only).map(|r| r.name.clone()).collect();
    names.sort();
    names.dedup();
    names
}

// ── One flow's state, swapped in while it runs ──

/// What one concurrent flow owns while it runs (run.ts `FlowFrame`, and the
/// async-local stores a flow started from another inherits a copy of).
#[derive(Debug, Default)]
pub(crate) struct FlowState {
    /// Its trace entries, spliced into the enclosing flow's in the flows'
    /// own order once they stop.
    pub trace: Vec<TraceEntry>,
    /// The functions this flow is inside (`callStack`, copied at the fork).
    pub call_stack: Vec<String>,
    /// The statements this flow is inside, innermost last.
    pub sites: Vec<Rc<Site>>,
    /// The body boundaries this flow is inside, outermost first.
    pub boundaries: Vec<Boundary>,
    pub write_order: WriteOrder,
    /// The effect locks this flow holds, by name.
    pub held: Vec<(String, LockMode)>,
    /// A flow other than the segment's main one: its trace is handed over
    /// only when it joins the flow that started it.
    pub forked: bool,
}

impl Run<'_> {
    /// Swaps the running flow's state with `state`.
    pub(crate) fn swap_flow(&self, state: &mut FlowState) {
        self.trace.swap(&mut state.trace);
        std::mem::swap(&mut *self.call_stack.borrow_mut(), &mut state.call_stack);
        std::mem::swap(&mut *self.call_sites.borrow_mut(), &mut state.sites);
        std::mem::swap(&mut *self.boundaries.borrow_mut(), &mut state.boundaries);
        std::mem::swap(&mut *self.write_order.borrow_mut(), &mut state.write_order);
        std::mem::swap(&mut *self.held_locks.borrow_mut(), &mut state.held);
        let forked = self.forked.replace(state.forked);
        state.forked = forked;
    }

    /// `openFlowFrame`: a flow started from the running one, its writes
    /// ordered under `order`: the call stack, the statement being run, the
    /// boundaries and the locks held copied; an empty trace of its own.
    pub(crate) fn open_flow(&self, order: WriteOrder) -> FlowState {
        FlowState {
            trace: Vec::new(),
            call_stack: self.call_stack.borrow().clone(),
            sites: self.call_sites.borrow().clone(),
            boundaries: self.boundaries.borrow().clone(),
            write_order: order,
            held: self.held_locks.borrow().clone(),
            forked: true,
        }
    }

    /// `forkWriteOrder(this.writeOrder)`.
    pub(crate) fn fork_writes(&self) -> Fork {
        self.write_order.borrow_mut().fork()
    }

    /// `future` run as the flow `state`.
    pub(crate) fn in_flow<'r, F: Future>(&'r self, state: FlowState, future: F) -> InFlow<'r, F>
    where
        Self: 'r,
    {
        InFlow { run: self, state: Some(state), future: Box::pin(future) }
    }
}

/// A future run as one flow: its state swapped in for every poll. It ends
/// with the flow's state as it left it (its trace among it).
pub(crate) struct InFlow<'r, F: Future> {
    run: &'r Run<'r>,
    state: Option<FlowState>,
    future: Pin<Box<F>>,
}

impl<F: Future> Future for InFlow<'_, F> {
    type Output = (F::Output, FlowState);

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        // Every field is Unpin (the future is boxed), so this is too.
        let this = self.get_mut();
        let mut state = this.state.take().expect("a flow is polled until it ends, not after");
        this.run.swap_flow(&mut state);
        let polled = this.future.as_mut().poll(cx);
        this.run.swap_flow(&mut state);
        match polled {
            Poll::Ready(output) => Poll::Ready((output, state)),
            Poll::Pending => {
                this.state = Some(state);
                Poll::Pending
            }
        }
    }
}

// ── One answer shared by every flow asking the same question ──

/// An answer some flow is fetching, which every other flow asking the same
/// question awaits rather than asking again (run.ts `resolutions` holds the
/// promise, taken before the request is answered).
pub(crate) struct Shared<T: Clone> {
    value: RefCell<Option<T>>,
    waiters: RefCell<Vec<Waker>>,
}

impl<T: Clone> Default for Shared<T> {
    fn default() -> Self {
        Shared { value: RefCell::new(None), waiters: RefCell::new(Vec::new()) }
    }
}

impl<T: Clone> Shared<T> {
    pub fn settle(&self, value: T) {
        *self.value.borrow_mut() = Some(value);
        for waker in std::mem::take(&mut *self.waiters.borrow_mut()) {
            waker.wake();
        }
    }

    /// Resolves once settled, with the value.
    pub fn wait(self: &Rc<Self>) -> SharedWait<T> {
        SharedWait { shared: self.clone() }
    }
}

pub(crate) struct SharedWait<T: Clone> {
    shared: Rc<Shared<T>>,
}

impl<T: Clone> Future for SharedWait<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
        if let Some(value) = self.shared.value.borrow().clone() {
            return Poll::Ready(value);
        }
        self.shared.waiters.borrow_mut().push(cx.waker().clone());
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared(group: &str) -> LockMode {
        LockMode::Shared(group.into())
    }

    fn held(acquire: &Acquire) -> bool {
        acquire.granted.get()
    }

    #[test]
    fn a_free_gate_is_taken_at_once_and_one_group_shares_it() {
        let gate = Rc::new(Gate::default());
        let (a, b) = (gate.acquire(shared("name")), gate.acquire(shared("name")));
        assert!(held(&a) && held(&b), "one group shares the lock");
        let other = gate.acquire(shared("domain"));
        assert!(!held(&other), "another group waits");
        gate.release();
        assert!(!held(&other), "until every holder has given it back");
        gate.release();
        assert!(held(&other));
        gate.release();
        assert!(gate.idle());
    }

    /// First come, first served: a flow that could join the holders still
    /// waits behind anyone already waiting, so one group cannot starve
    /// another (effect_locks.ts `Gate`).
    #[test]
    fn a_compatible_ask_waits_behind_a_waiter() {
        let gate = Rc::new(Gate::default());
        let first = gate.acquire(shared("name"));
        let exclusive = gate.acquire(LockMode::Exclusive);
        let late = gate.acquire(shared("name"));
        assert!(held(&first) && !held(&exclusive) && !held(&late));
        gate.release();
        assert!(held(&exclusive) && !held(&late), "the exclusive ask was first in line");
        gate.release();
        assert!(held(&late));
        gate.release();
        assert!(gate.idle());
    }

    /// A shared group, then an exclusive ask, then the group again: each is
    /// granted in arrival order, a run of compatible waiters together.
    #[test]
    fn release_grants_in_arrival_order_a_compatible_run_together() {
        let gate = Rc::new(Gate::default());
        let exclusive = gate.acquire(LockMode::Exclusive);
        let (a, b) = (gate.acquire(shared("k")), gate.acquire(shared("k")));
        let then = gate.acquire(LockMode::Exclusive);
        let c = gate.acquire(shared("k"));
        assert!(held(&exclusive) && !held(&a) && !held(&b) && !held(&then) && !held(&c));
        gate.release();
        assert!(held(&a) && held(&b), "the two shared waiters at the front, together");
        assert!(!held(&then) && !held(&c), "the exclusive ask behind them stops the run");
        gate.release();
        assert!(!held(&then));
        gate.release();
        assert!(held(&then) && !held(&c));
        gate.release();
        assert!(held(&c));
        gate.release();
        assert!(gate.idle());
    }
}
