// Preloaded into the served module's process (`node --require`) so its
// `Date.now()` is the instant the recording was made at: the adapter stamps a
// new saved search's visit mark from the clock, and a replay must send the
// same body.
const FIXED_NOW = 1_790_000_000_000;
Date.now = () => FIXED_NOW;
module.exports = { FIXED_NOW };
