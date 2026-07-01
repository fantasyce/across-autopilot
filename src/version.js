import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export function packageVersion(fallback = "0.0.0") {
  try {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    return String(packageJson.version || fallback);
  } catch {
    return fallback;
  }
}

export const AUTOPILOT_VERSION = packageVersion();
