//! An executor for the tests whose clock moves only when everything in
//! flight is waiting on it, so a test can say how long a run took in game
//! time without sleeping.

use std::cell::RefCell;
use std::future::Future;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

/// Milliseconds of virtual time, shared by the executor and the hosts that
/// wait on it.
#[derive(Clone, Default)]
pub(crate) struct Time(Rc<RefCell<Timers>>);

#[derive(Default)]
struct Timers {
    now_ms: u64,
    due: Vec<u64>,
}

impl Time {
    pub(crate) fn now_ms(&self) -> u64 {
        self.0.borrow().now_ms
    }

    /// Lands `ms` after it is made.
    pub(crate) fn sleep(&self, ms: u64) -> impl Future<Output = ()> + 'static {
        let time = self.clone();
        let until = self.now_ms() + ms;
        std::future::poll_fn(move |_| {
            let mut timers = time.0.borrow_mut();
            if timers.now_ms >= until {
                Poll::Ready(())
            } else {
                timers.due.push(until);
                Poll::Pending
            }
        })
    }

    /// Drive `future` to its end, moving the clock to the next timer
    /// whenever nothing else can move.
    pub(crate) fn block_on<F: Future>(&self, future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(out) = future.as_mut().poll(&mut cx) {
                return out;
            }
            let mut timers = self.0.borrow_mut();
            let next = timers.due.iter().copied().min().expect("the run is waiting on nothing the clock can bring");
            timers.now_ms = next;
            timers.due.retain(|t| *t > next);
        }
    }
}

/// Drive a future whose hosts all answer from memory.
pub(crate) fn block_on<F: Future>(future: F) -> F::Output {
    Time::default().block_on(future)
}
