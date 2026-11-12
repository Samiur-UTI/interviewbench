// Preloaded by `npm test` (node --import). If the code under test leaves a timer or socket open,
// node --test would wait for it forever after the last test; this ends such a test file's process
// two seconds after its last test, once every result has been reported. A file that leaks nothing
// exits as soon as it's done (the timer is unref'd). It stands in for --test-force-exit, which
// exits so early that test results go missing from the report.
import { after } from "node:test";

after(() => {
  setTimeout(() => process.exit(), 2000).unref();
});
