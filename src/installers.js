import { access, chmod, cp, mkdir, realpath, rm, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPONENT_ID, ecosystemBinDir, ecosystemHome, pluginRoot } from "./paths.js";
import { renderPluginManifest } from "./plugin-manifest.js";

const HOST_PLUGIN_PACKAGE_ENTRIES = [
  "src",
  "sources",
  "examples",
  "README.md",
  "AUTOPILOT_RFC.md",
  "LICENSE",
  "package.json"
];
const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export async function installHostPlugin(options = {}) {
  const sourceRoot = resolve(options.sourceRoot || PACKAGE_ROOT);
  const env = options.env || process.env;
  const acrossHome = resolve(options.acrossHome || ecosystemHome(env));
  const root = resolve(options.pluginRoot || pluginRoot({ ...env, ACROSS_HOME: acrossHome }));
  const binDir = resolve(options.binDir || ecosystemBinDir({ ...env, ACROSS_HOME: acrossHome }));
  const installDir = join(root, COMPONENT_ID);
  const commandPath = join(binDir, "across-autopilot");
  const sourceReal = await realpathOrResolve(sourceRoot);
  const installReal = await realpathOrResolve(installDir);
  assertHostPluginRuntimePathAllowed("ACROSS_HOME", acrossHome, env);
  assertHostPluginRuntimePathAllowed("ACROSS_PLUGIN_HOME", root, env);
  assertHostPluginRuntimePathAllowed("ACROSS_BIN_HOME", binDir, env);

  if (sourceReal !== installReal) {
    const tmpDir = `${installDir}.tmp-${process.pid}-${Date.now()}`;
    try {
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });
      for (const entry of HOST_PLUGIN_PACKAGE_ENTRIES) {
        await copyPackageEntry(sourceRoot, tmpDir, entry);
      }
      await rm(installDir, { recursive: true, force: true });
      await rename(tmpDir, installDir);
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true });
      throw error;
    }
  }

  await mkdir(binDir, { recursive: true });
  await writeFile(commandPath, renderNodeWrapper(commandPath, join(installDir, "src", "cli.js")), "utf8");
  await chmod(commandPath, 0o755);
  await writeFile(
    join(installDir, "manifest.json"),
    `${JSON.stringify(await renderPluginManifest({ acrossHome, commandPath, installDir, sourceRoot, publicPaths: true }), null, 2)}\n`,
    "utf8"
  );

  return {
    target: "host-plugin",
    prefix: root,
    acrossHome,
    installDir,
    binDir,
    commandPath
  };
}

export async function uninstallHostPlugin(options = {}) {
  const env = options.env || process.env;
  const acrossHome = resolve(options.acrossHome || ecosystemHome(env));
  const root = resolve(options.pluginRoot || pluginRoot({ ...env, ACROSS_HOME: acrossHome }));
  const binDir = resolve(options.binDir || ecosystemBinDir({ ...env, ACROSS_HOME: acrossHome }));
  const installDir = join(root, COMPONENT_ID);
  const commandPath = join(binDir, "across-autopilot");
  assertHostPluginRuntimePathAllowed("ACROSS_HOME", acrossHome, env);
  assertHostPluginRuntimePathAllowed("ACROSS_PLUGIN_HOME", root, env);
  assertHostPluginRuntimePathAllowed("ACROSS_BIN_HOME", binDir, env);

  await rm(commandPath, { force: true });
  await rm(installDir, { recursive: true, force: true });

  return {
    target: "host-plugin",
    removed: true,
    installDir,
    commandPath
  };
}

async function copyPackageEntry(sourceRoot, targetRoot, entry) {
  const source = join(sourceRoot, entry);
  if (!(await pathExists(source))) return;
  const target = join(targetRoot, entry);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrResolve(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function renderNodeWrapper(commandPath, targetPath) {
  const targetRelativePath = relative(dirname(commandPath), targetPath) || ".";
  return [
    "#!/bin/sh",
    "SCRIPT_DIR=$(CDPATH= cd \"$(dirname \"$0\")\" && pwd)",
    `exec /usr/bin/env node "$SCRIPT_DIR"/${shellQuote(targetRelativePath)} "$@"`,
    ""
  ].join("\n");
}

function assertHostPluginRuntimePathAllowed(name, value, env) {
  if (!isProductMode(env) || isDeveloperMode(env)) return;
  if (!containsProtectedUserReference(value, env)) return;
  throw new Error(`${name} points to a protected user directory; use ~/.across or set ACROSS_AUTOPILOT_DEVELOPER_MODE=1 for source-checkout development.`);
}

function isProductMode(env) {
  return truthy(env.ACROSS_AUTOPILOT_PRODUCT_MODE) || truthy(env.ACROSS_AGENTS_PRODUCT_MODE);
}

function isDeveloperMode(env) {
  return truthy(env.ACROSS_AUTOPILOT_DEVELOPER_MODE) || truthy(env.ACROSS_AGENTS_DEVELOPER_MODE);
}

function truthy(value) {
  return ["1", "true", "yes", "on", "y"].includes(String(value || "").trim().toLowerCase());
}

function containsProtectedUserReference(value, env) {
  const expanded = resolve(String(value || "").replace(/^~(?=$|\/)/, env.HOME || process.env.HOME || ""));
  const home = resolve(env.HOME || process.env.HOME || "");
  const protectedRoots = ["Documents", "Desktop", "Downloads"].map((name) => join(home, name));
  if (protectedRoots.some((root) => pathIsAtOrBelow(expanded, root))) return true;
  return /(?:~|\/Users\/[^/]+)\/(Documents|Desktop|Downloads)(?:\/|$)/.test(String(value || ""));
}

function pathIsAtOrBelow(path, root) {
  return path === root || path.startsWith(`${root}/`);
}
