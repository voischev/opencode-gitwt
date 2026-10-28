import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import { GitwtError } from "./process.js";

const defaults = {
  remote: "origin",
  base: "auto",
  prefix: "",
  terminal: "auto",
  forkSession: true,
  sync: { copyFiles: [], symlinkDirs: [], exclude: [] },
  hooks: { postCreate: [], preRemove: [] },
};

export function expandPath(value, home = os.homedir(), base = process.cwd()) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(home, value.slice(2));
  }
  return path.resolve(base, value);
}

async function readConfig(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  try {
    let value;
    if (file.endsWith(".jsonc")) {
      const errors = [];
      value = parseJsonc(text, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error("Невалидный JSONC");
    } else {
      value = parseYaml(text);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Ожидается объект настроек");
    }
    return value;
  } catch (error) {
    throw new GitwtError("invalid_config", `Не удалось прочитать ${file}: ${error.message}`);
  }
}

function normalize(config) {
  const result = { ...config };
  for (const key of ["sync", "hooks"]) {
    if (
      result[key] !== undefined &&
      (!result[key] || typeof result[key] !== "object" || Array.isArray(result[key]))
    ) {
      throw new GitwtError("invalid_config", `${key} должен быть объектом`);
    }
  }
  if ("worktree_dir" in result) {
    result.worktreeDir = result.worktree_dir;
    delete result.worktree_dir;
  }
  result.hooks = { ...result.hooks };
  for (const [old, key] of [
    ["post_create", "postCreate"],
    ["pre_remove", "preRemove"],
  ]) {
    if (old in result) {
      result.hooks[key] = [result[old]];
      delete result[old];
    }
  }
  return result;
}

export function mergeConfig(...values) {
  const result = {};
  for (const value of values) {
    const clean = Object.fromEntries(
      Object.entries(value ?? {}).filter(([, v]) => v !== undefined),
    );
    const next = normalize(clean);
    const sync = { ...result.sync, ...next.sync };
    const hooks = { ...result.hooks, ...next.hooks };
    Object.assign(result, next, { sync, hooks });
  }
  return result;
}

function validate(config) {
  const keys = new Set([
    "remote",
    "base",
    "prefix",
    "worktreeDir",
    "setup",
    "terminal",
    "launchCommand",
    "forkSession",
    "sync",
    "hooks",
  ]);
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new GitwtError("invalid_config", `Неизвестная настройка: ${key}`);
  }
  for (const key of ["remote", "base", "prefix", "worktreeDir", "terminal"]) {
    if (config[key] !== undefined && typeof config[key] !== "string") {
      throw new GitwtError("invalid_config", `${key} должен быть строкой`);
    }
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(config.remote) || config.remote.startsWith("-")) {
    throw new GitwtError("invalid_config", "Недопустимое имя remote");
  }
  if (typeof config.forkSession !== "boolean") {
    throw new GitwtError("invalid_config", "forkSession должен быть boolean");
  }
  if (
    ![
      "auto",
      "none",
      "tmux",
      "cmux",
      "terminal",
      "iterm",
      "ghostty",
      "kitty",
      "wezterm",
      "alacritty",
      "warp",
      "gnome-terminal",
      "konsole",
      "xterm",
      "windows-terminal",
    ].includes(config.terminal)
  ) {
    throw new GitwtError("invalid_config", `Неизвестный терминал: ${config.terminal}`);
  }
  const commandValid = (value) =>
    (typeof value === "string" && value.trim()) ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.every((part) => typeof part === "string") &&
      value[0].length > 0);
  for (const key of ["setup", "launchCommand"]) {
    if (config[key] !== undefined && !commandValid(config[key])) {
      throw new GitwtError(
        "invalid_config",
        `${key} должен содержать команду или массив аргументов`,
      );
    }
  }
  if (
    Array.isArray(config.launchCommand) &&
    config.launchCommand.some((part) => part.length === 0)
  ) {
    throw new GitwtError("invalid_config", "launchCommand должен содержать непустые аргументы");
  }
  for (const [group, fields] of [
    ["sync", ["copyFiles", "symlinkDirs", "exclude"]],
    ["hooks", ["postCreate", "preRemove"]],
  ]) {
    for (const [key, value] of Object.entries(config[group])) {
      if (!fields.includes(key) || !Array.isArray(value)) {
        throw new GitwtError("invalid_config", `Недопустимая настройка ${group}.${key}`);
      }
      if (group === "sync" && value.some((item) => typeof item !== "string")) {
        throw new GitwtError("invalid_config", `${group}.${key} должен содержать строки`);
      }
      if (group === "hooks" && value.some((item) => !commandValid(item))) {
        throw new GitwtError("invalid_config", `${group}.${key} должен содержать команды`);
      }
    }
  }
  return config;
}

export async function loadConfig(root, overrides = {}, home = os.homedir()) {
  let globalLegacy;
  for (const file of [path.join(home, ".git-wt"), path.join(home, ".config/git-wt.yml")]) {
    globalLegacy = await readConfig(file);
    if (globalLegacy) break;
  }
  const config = validate(
    mergeConfig(
      defaults,
      globalLegacy,
      await readConfig(path.join(home, ".config/opencode/gitwt.jsonc")),
      await readConfig(path.join(root, ".git-wt.yml")),
      await readConfig(path.join(root, ".opencode/gitwt.jsonc")),
      overrides,
    ),
  );
  if (config.worktreeDir) config.worktreeDir = expandPath(config.worktreeDir, home, root);
  return config;
}
