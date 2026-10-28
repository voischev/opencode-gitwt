import fs from "node:fs";
import path from "node:path";

import { GitwtError, run } from "./process.js";

const IS_WINDOWS = process.platform === "win32";

function isGitName(name) {
  return name.toLowerCase() === ".git";
}

function shellInvocation(command) {
  if (IS_WINDOWS) {
    return [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command];
  }
  return ["bash", "-c", command];
}

function assertCommand(command) {
  if (Array.isArray(command)) {
    if (
      command.length === 0 ||
      typeof command[0] !== "string" ||
      command[0].length === 0 ||
      command.some((part) => typeof part !== "string")
    ) {
      throw new GitwtError("invalid_command", "Команда должна быть непустым массивом строк", {
        command,
      });
    }
    return;
  }
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new GitwtError("invalid_command", "Команда должна быть непустой строкой", { command });
  }
}

async function runCommand(command, cwd, env, signal) {
  assertCommand(command);
  const [bin, ...args] = Array.isArray(command) ? command : shellInvocation(command);
  return run(bin, args, { cwd, env, signal });
}

export async function runHooks(commands, cwd, env = {}, signal) {
  if (commands == null) {
    return;
  }
  if (!Array.isArray(commands)) {
    throw new GitwtError("invalid_hooks", "Список хуков должен быть массивом команд", {});
  }
  for (const command of commands) {
    await runCommand(command, cwd, env, signal);
  }
}

function validateRelativePath(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitwtError("invalid_sync_path", `Поле ${field} должно содержать относительный путь`, {
      field,
      path: value,
    });
  }
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new GitwtError("invalid_sync_path", `Абсолютный путь недопустим в ${field}: ${value}`, {
      field,
      path: value,
    });
  }
  for (const segment of value.split(/[\\/]+/)) {
    if (segment === "." || segment === "..") {
      throw new GitwtError("invalid_sync_path", `Путь не должен содержать "${segment}": ${value}`, {
        field,
        path: value,
      });
    }
    if (isGitName(segment)) {
      throw new GitwtError(
        "invalid_sync_path",
        `Каталог .git нельзя синхронизировать через ${field}: ${value}`,
        { field, path: value },
      );
    }
  }
  const normalized = path.normalize(value);
  const segments = normalized.split(path.sep);
  if (
    path.isAbsolute(normalized) ||
    segments.includes(".") ||
    segments.includes("..") ||
    segments.some(isGitName)
  ) {
    throw new GitwtError("invalid_sync_path", `Недопустимый путь в ${field}: ${value}`, {
      field,
      path: value,
    });
  }
  return normalized;
}

function isInside(base, candidate) {
  return candidate === base || candidate.startsWith(base + path.sep);
}

function resolveSafe(base, rel, label) {
  let current = base;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      break;
    }
    if (stats.isSymbolicLink()) {
      const real = fs.realpathSync(current);
      if (!isInside(base, real)) {
        throw new GitwtError(
          "path_escape",
          `${label} выходит за пределы допустимого каталога: ${rel}`,
          {
            path: rel,
          },
        );
      }
      current = real;
    }
  }
  return current;
}

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function ensureParentDirs(base, rel) {
  const parent = path.dirname(rel);
  if (parent === "." || parent === "") {
    return;
  }
  try {
    fs.mkdirSync(path.join(base, parent), { recursive: true });
  } catch (error) {
    throw new GitwtError(
      "target_conflict",
      `Не удалось подготовить каталог ${parent} в рабочем дереве: ${error.message}`,
      { path: parent },
    );
  }
}

function createMatcher(patterns) {
  if (patterns != null && !Array.isArray(patterns)) {
    throw new GitwtError(
      "invalid_exclude",
      "Поле sync.exclude должно быть массивом glob-шаблонов",
      {},
    );
  }
  const list = (patterns ?? []).map((pattern) => {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new GitwtError("invalid_exclude", "Шаблон exclude должен быть непустой строкой", {
        pattern,
      });
    }
    return pattern.split(/[\\/]+/).join(path.sep);
  });
  return (rel) => {
    const base = path.basename(rel);
    return list.some(
      (pattern) => path.matchesGlob(rel, pattern) || path.matchesGlob(base, pattern),
    );
  };
}

function copyEntry(sourceRoot, targetRoot, rel, isExcluded) {
  if (isGitName(path.basename(rel))) {
    throw new GitwtError("invalid_sync_path", `Каталог .git нельзя копировать: ${rel}`, {
      path: rel,
    });
  }
  const source = path.join(sourceRoot, rel);
  const target = path.join(targetRoot, rel);
  let stats;
  try {
    stats = fs.lstatSync(source);
  } catch {
    throw new GitwtError("source_missing", `Источник не найден: ${rel}`, { path: rel });
  }
  if (stats.isSymbolicLink()) {
    throw new GitwtError(
      "symlink_not_allowed",
      `Симлинк нельзя скопировать, допустимы только явные симлинки каталогов: ${rel}`,
      { path: rel },
    );
  }
  if (pathExists(target)) {
    throw new GitwtError("target_exists", `В рабочем дереве уже существует ${rel}`, { path: rel });
  }
  ensureParentDirs(targetRoot, rel);
  if (stats.isDirectory()) {
    fs.mkdirSync(target);
    for (const name of fs.readdirSync(source)) {
      const childRel = path.join(rel, name);
      if (isExcluded(childRel)) {
        continue;
      }
      copyEntry(sourceRoot, targetRoot, childRel, isExcluded);
    }
    return;
  }
  if (stats.isFile()) {
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new GitwtError("target_exists", `В рабочем дереве уже существует ${rel}`, {
          path: rel,
        });
      }
      throw error;
    }
    fs.chmodSync(target, stats.mode & 0o777);
    return;
  }
  throw new GitwtError("unsupported_entry", `Неподдерживаемый тип записи: ${rel}`, { path: rel });
}

export async function prepareEnvironment(sourceDir, targetDir, config, { signal, env } = {}) {
  const sourceRoot = fs.realpathSync(sourceDir);
  const targetRoot = fs.realpathSync(targetDir);
  const sync = config?.sync ?? {};
  const hooks = config?.hooks ?? {};
  const isExcluded = createMatcher(sync.exclude);

  for (const entry of sync.copyFiles ?? []) {
    const rel = validateRelativePath(entry, "sync.copyFiles");
    if (isExcluded(rel)) {
      continue;
    }
    resolveSafe(sourceRoot, rel, "Путь источника");
    resolveSafe(targetRoot, rel, "Путь назначения");
    copyEntry(sourceRoot, targetRoot, rel, isExcluded);
  }

  for (const entry of sync.symlinkDirs ?? []) {
    const rel = validateRelativePath(entry, "sync.symlinkDirs");
    if (isExcluded(rel)) {
      continue;
    }
    const source = resolveSafe(sourceRoot, rel, "Путь источника");
    resolveSafe(targetRoot, rel, "Путь назначения");
    let stats;
    try {
      stats = fs.statSync(source);
    } catch {
      throw new GitwtError("source_missing", `Источник симлинка не найден: ${rel}`, { path: rel });
    }
    if (!stats.isDirectory()) {
      throw new GitwtError("symlink_source_not_dir", `Симлинк допустим только на каталог: ${rel}`, {
        path: rel,
      });
    }
    if (!isInside(sourceRoot, source)) {
      throw new GitwtError("path_escape", `Источник симлинка вне исходного каталога: ${rel}`, {
        path: rel,
      });
    }
    const target = path.join(targetRoot, rel);
    if (pathExists(target)) {
      throw new GitwtError("target_exists", `В рабочем дереве уже существует ${rel}`, {
        path: rel,
      });
    }
    ensureParentDirs(targetRoot, rel);
    fs.symlinkSync(source, target, "dir");
  }

  if (config?.setup != null) {
    await runCommand(config.setup, targetDir, env, signal);
  }

  await runHooks(hooks.postCreate, targetDir, env, signal);
}
