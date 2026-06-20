import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const COMPONENT_ID = "across-autopilot";

export function ecosystemHome(env = process.env) {
  return resolve(expandHome(env.ACROSS_HOME || join(homedir(), ".across"), env));
}

export function componentDataHome(componentId = COMPONENT_ID, env = process.env) {
  return resolve(expandHome(env.ACROSS_AUTOPILOT_HOME || join(ecosystemHome(env), "data", componentId), env));
}

export function pluginRoot(env = process.env) {
  return resolve(expandHome(env.ACROSS_PLUGIN_HOME || join(ecosystemHome(env), "plugins"), env));
}

export function ecosystemBinDir(env = process.env) {
  return resolve(expandHome(env.ACROSS_BIN_HOME || join(ecosystemHome(env), "bin"), env));
}

export function componentRunHome(componentId = COMPONENT_ID, env = process.env) {
  return resolve(join(ecosystemHome(env), "run", componentId));
}

export function componentLogHome(componentId = COMPONENT_ID, env = process.env) {
  return resolve(join(ecosystemHome(env), "logs", componentId));
}

export function componentConfigHome(componentId = COMPONENT_ID, env = process.env) {
  return resolve(join(ecosystemHome(env), "config", componentId));
}

export function componentCacheHome(componentId = COMPONENT_ID, env = process.env) {
  return resolve(join(ecosystemHome(env), "cache", componentId));
}

export function expandHome(value, env = process.env) {
  const home = env.HOME || homedir();
  return String(value || "").replace(/^~(?=$|\/)/, home);
}

