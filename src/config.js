import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { z } from "zod";
import { GitwtError } from "./process.js";

const command = z.union([z.string().min(1), z.tuple([z.string().min(1)]).rest(z.string())]);
export const hooksSchema = z
  .object({
    postCreate: z.array(command).default([]),
    preRemove: z.array(command).default([]),
  })
  .strict();
const schema = z
  .object({
    remote: z
      .string()
      .regex(/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/)
      .default("origin"),
    base: z.string().min(1).default("auto"),
    prefix: z.string().default(""),
    worktreeDir: z.string().min(1).optional(),
    hooks: hooksSchema.default({ postCreate: [], preRemove: [] }),
  })
  .strict();

export function expandPath(value, home = os.homedir(), base = process.cwd()) {
  if (value === "~") return home;
  return path.resolve(
    value.startsWith("~/") ? home : base,
    value.startsWith("~/") ? value.slice(2) : value,
  );
}

async function readConfig(file) {
  try {
    const errors = [];
    const value = parse(await readFile(file, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Ожидается объект JSONC");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new GitwtError("invalid_config", `Не удалось прочитать ${file}: ${error.message}`);
  }
}

export async function loadConfig(root, overrides = {}, home = os.homedir()) {
  const config = { hooks: {} };
  for (const value of [
    await readConfig(path.join(home, ".config/opencode/gitwt.jsonc")),
    await readConfig(path.join(root, ".opencode/gitwt.jsonc")),
    Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  ]) {
    const checked = schema.partial().safeParse(value);
    if (!checked.success)
      throw new GitwtError(
        "invalid_config",
        `Некорректные настройки: ${checked.error.issues.map((issue) => issue.path.join(".") || "неизвестное поле").join(", ")}`,
      );
    const hooks = { ...config.hooks, ...value.hooks };
    Object.assign(config, value, { hooks });
  }
  const resolved = schema.parse(config);
  if (resolved.worktreeDir) resolved.worktreeDir = expandPath(resolved.worktreeDir, home, root);
  return resolved;
}
