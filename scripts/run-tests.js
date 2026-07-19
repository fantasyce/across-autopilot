import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const suiteRoot = await mkdtemp(join(tmpdir(), "across-autopilot-test-suite-"));

try {
  const testFiles = (await readdir("tests"))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join("tests", name));
  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    env: {
      ...process.env,
      TMPDIR: suiteRoot,
      TMP: suiteRoot,
      TEMP: suiteRoot
    },
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`Autopilot tests terminated by ${result.signal}`);
  }
  process.exitCode = result.status ?? 1;
} finally {
  await rm(suiteRoot, { recursive: true, force: true });
}
