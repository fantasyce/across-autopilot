import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

export function stableJson(value) {
  return JSON.stringify(sortJson(value), null, 2);
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "loop";
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function compactTimestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

export function unique(values) {
  return [...new Set((values || []).filter((value) => value !== undefined && value !== null))];
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}
