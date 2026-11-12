// Preloaded into every test file's process with `node --import`, by tests/test.sh.
//
// Why not --test-force-exit: it exits the moment the last test settles, before the file's results
// have all reached the runner, and the runner then drops testcases at random from junit.xml. The
// stage 1 starter scored its true 5/13 in only 5 of 18 runs with it, and in 13 of 13 without.
//
// Without it, a timer or socket the code under test leaves open keeps the file's process alive
// after its last test, so the run would hang until the outer `timeout` in test.sh. This guard
// exits such a process GRACE_MS after the file's last test, with every result already reported.
// The timer is unref'd: a file that leaks nothing exits as soon as it's done, with no delay.
import { after } from "node:test";

const GRACE_MS = 2000;

after(() => {
  setTimeout(() => process.exit(), GRACE_MS).unref();
});
