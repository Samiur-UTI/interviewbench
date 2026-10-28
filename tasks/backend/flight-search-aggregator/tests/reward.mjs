// Usage: node reward.mjs <junit.xml> <reward.txt>
// Writes passed/total (4 decimals). A testcase containing <failure, <error or <skipped is not
// passed. A missing or unreadable report scores 0.
import { readFileSync, writeFileSync } from "node:fs";

const [junitPath, rewardPath] = process.argv.slice(2);
let reward = 0;
try {
  const xml = readFileSync(junitPath, "utf8");
  const cases = xml.match(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g) ?? [];
  const bad = cases.filter((c) => /<(failure|error|skipped)\b/.test(c)).length;
  if (cases.length > 0) reward = (cases.length - bad) / cases.length;
} catch {
  reward = 0;
}
writeFileSync(rewardPath, `${reward.toFixed(4)}\n`);
