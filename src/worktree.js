import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandPath, hooksSchema, loadConfig } from "./config.js";
import { runHooks } from "./environment.js";
import { GitwtError, git } from "./process.js";

export async function repository(cwd) {
  const root = await git(["rev-parse", "--show-toplevel"], cwd);
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return {
    root: await realpath(root.stdout.trim()),
    commonDir: await realpath(common.stdout.trim()),
  };
}

export function parseWorktrees(text) {
  return text
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const item = {};
      for (const field of block.split("\0").filter(Boolean)) {
        const space = field.indexOf(" ");
        const key = space < 0 ? field : field.slice(0, space);
        const value = space < 0 ? true : field.slice(space + 1);
        if (key === "worktree") item.worktreePath = value;
        if (key === "HEAD") item.head = value;
        if (key === "branch") item.branch = value.replace(/^refs\/heads\//, "");
        if (["detached", "locked", "prunable", "bare"].includes(key)) item[key] = value;
      }
      return item;
    });
}

export async function listWorktrees(cwd, { status = false } = {}) {
  const repo = await repository(cwd);
  const items = parseWorktrees(
    (await git(["worktree", "list", "--porcelain", "-z"], repo.root)).stdout,
  );
  for (const item of items) {
    item.current = item.worktreePath === repo.root;
    if (!status || "prunable" in item || item.bare) continue;
    item.dirty = Boolean((await git(["status", "--porcelain", "-z"], item.worktreePath)).stdout);
    const upstream = await git(
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      item.worktreePath,
      { allowFailure: true },
    );
    if (upstream.code === 0)
      [item.ahead, item.behind] = upstream.stdout.trim().split(/\s+/).map(Number);
  }
  return items;
}

export async function resolveWorktree(cwd, target, options) {
  if (typeof target !== "string" || !target)
    throw new GitwtError("invalid_target", "Укажите ветку или полный путь worktree");
  const expanded = expandPath(target, os.homedir(), cwd);
  const fullPath = await realpath(expanded).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return expanded;
  });
  const matches = (await listWorktrees(cwd, options)).filter(
    (item) => item.branch === target || item.worktreePath === fullPath,
  );
  if (matches.length !== 1)
    throw new GitwtError("worktree_missing", `Worktree не найден или имя неоднозначно: ${target}`);
  if ("prunable" in matches[0])
    throw new GitwtError(
      "worktree_missing",
      `Каталог worktree недоступен: ${matches[0].worktreePath}`,
    );
  await realpath(matches[0].worktreePath);
  return matches[0];
}

async function validBranch(branch, cwd) {
  if (typeof branch !== "string" || !branch || branch.startsWith("-"))
    throw new GitwtError("invalid_name", "Укажите корректное имя ветки");
  if (
    (await git(["check-ref-format", `refs/heads/${branch}`], cwd, { allowFailure: true })).code !==
    0
  ) {
    throw new GitwtError("invalid_name", `Недопустимое имя ветки: ${branch}`);
  }
}

async function retryGit(args, cwd, signal) {
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    result = await git(args, cwd, { allowFailure: true, signal });
    if (result.code === 0) return result;
    signal?.throwIfAborted();
  }
  throw new GitwtError(
    "fetch_failed",
    `Git ${args[0]} завершился с ошибкой после двух попыток: ${result.stderr.trim()}`,
  );
}

async function baseReference(cwd, config, { from, signal }) {
  if (from) {
    if (from.startsWith("-")) throw new GitwtError("invalid_base", "Недопустимая стартовая ссылка");
    return (
      await git(["rev-parse", "--verify", `${from}^{commit}`], cwd, { signal })
    ).stdout.trim();
  }
  let base = config.base;
  if (base === "auto") {
    const refs = await retryGit(
      ["ls-remote", "--heads", config.remote, "trunk", "main", "master"],
      cwd,
      signal,
    );
    base = ["trunk", "main", "master"].find((name) =>
      refs.stdout.split("\n").some((line) => line.endsWith(`refs/heads/${name}`)),
    );
    if (!base) {
      const head = await retryGit(["ls-remote", "--symref", config.remote, "HEAD"], cwd, signal);
      base = head.stdout.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
    }
  }
  if (!base)
    throw new GitwtError("base_missing", "Не удалось определить базовую ветку; укажите --base");
  await validBranch(base, cwd);
  const ref = `refs/remotes/${config.remote}/${base}`;
  await retryGit(["fetch", "--no-tags", config.remote, `${base}:${ref}`], cwd, signal);
  return (await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd)).stdout.trim();
}

async function hookFile(cwd) {
  return (
    await git(
      ["rev-parse", "--path-format=absolute", "--git-path", "opencode-gitwt-hooks.json"],
      cwd,
    )
  ).stdout.trim();
}

async function readHooks(cwd) {
  try {
    return hooksSchema.parse(JSON.parse(await readFile(await hookFile(cwd), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new GitwtError("invalid_hooks", `Не удалось прочитать снимок хуков: ${error.message}`);
  }
}

export async function inspectHooks(cwd, target) {
  const item = await resolveWorktree(cwd, target);
  const hooks = await readHooks(item.worktreePath);
  return {
    worktreePath: item.worktreePath,
    snapshot: hooks ? "present" : "absent",
    postCreate: hooks ? (hooks.postCreate.length ? "configured" : "none") : "unknown",
    preRemove: hooks ? (hooks.preRemove.length ? "configured" : "none") : "unknown",
  };
}

export async function createWorktree(cwd, options = {}) {
  const repo = await repository(cwd);
  const home = options.home ?? os.homedir();
  const config = await loadConfig(repo.root, options.config, home);
  const branch = `${config.prefix}${options.branch ?? ""}`;
  await validBranch(options.branch, repo.root);
  await validBranch(branch, repo.root);
  if (
    (
      await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo.root, {
        allowFailure: true,
      })
    ).code === 0
  ) {
    throw new GitwtError(
      "branch_exists",
      `Ветка ${branch} уже существует; создайте новую от нужной базы`,
    );
  }
  const primary = (await listWorktrees(repo.root))[0].worktreePath;
  const id = createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 8);
  const target = options.path
    ? expandPath(options.path, home, repo.root)
    : path.join(
        config.worktreeDir ?? path.join(home, "git-wt"),
        `${path.basename(primary)}-${id}`,
        branch,
      );
  const existing = await lstat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing || (await listWorktrees(repo.root)).some((item) => item.worktreePath === target)) {
    throw new GitwtError("worktree_exists", `Путь уже занят: ${target}`);
  }
  const head = await baseReference(repo.root, config, options);
  await mkdir(path.dirname(target), { recursive: true });
  const worktreePath = path.join(await realpath(path.dirname(target)), path.basename(target));
  const hooks = options.noHooks ? { postCreate: [], preRemove: [] } : config.hooks;
  try {
    await git(
      ["worktree", "add", "--no-track", "-b", branch, "--", worktreePath, head],
      repo.root,
      { signal: options.signal },
    );
    const actualRoot = (await git(["rev-parse", "--show-toplevel"], worktreePath)).stdout.trim();
    const actualBranch = (await git(["branch", "--show-current"], worktreePath)).stdout.trim();
    const actualHead = (await git(["rev-parse", "HEAD"], worktreePath)).stdout.trim();
    const actual = await resolveWorktree(repo.root, worktreePath);
    if (
      (await realpath(actualRoot)) !== worktreePath ||
      actualBranch !== branch ||
      actualHead !== head ||
      actual.branch !== branch ||
      actual.head !== head
    ) {
      throw new GitwtError("verification_failed", "Проверка корня, ветки или HEAD не прошла");
    }
    await writeFile(await hookFile(worktreePath), `${JSON.stringify(hooks)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new GitwtError(
      "worktree_create_failed",
      `Создание ${worktreePath} завершилось ошибкой; проверьте этот путь перед повтором: ${error.message}`,
      { worktreePath },
    );
  }
  const warnings = [];
  try {
    await runHooks(
      hooks.postCreate,
      worktreePath,
      { BRANCH: branch, WORKTREE_PATH: worktreePath, HEAD: head, SOURCE_PATH: repo.root },
      options.signal,
    );
  } catch (error) {
    warnings.push(`Worktree создан, но postCreate завершился с ошибкой: ${error.message}`);
  }
  return { branch, worktreePath, head, warnings };
}

export async function removeWorktree(cwd, target, options = {}) {
  const repo = await repository(cwd);
  const items = await listWorktrees(repo.root);
  const item = await resolveWorktree(repo.root, target);
  if (item.worktreePath === items[0].worktreePath || item.current) {
    throw new GitwtError(
      "protected_worktree",
      "Нельзя удалить основной или текущий worktree; запустите удаление из другого worktree",
    );
  }
  const assertClean = async () => {
    if (!options.force && (await git(["status", "--porcelain", "-z"], item.worktreePath)).stdout) {
      throw new GitwtError(
        "worktree_dirty",
        "Worktree содержит изменения; явный --force удалит их",
      );
    }
  };
  const hooks = await readHooks(item.worktreePath);
  await assertClean();
  await runHooks(
    hooks?.preRemove ?? [],
    item.worktreePath,
    { BRANCH: item.branch ?? "", WORKTREE_PATH: item.worktreePath, HEAD: item.head },
    options.signal,
  );
  await assertClean();
  await git(
    ["worktree", "remove", ...(options.force ? ["--force"] : []), "--", item.worktreePath],
    repo.root,
    { signal: options.signal },
  );
  const warnings = [];
  let branchDeleted = false;
  if (item.branch && options.deleteBranch !== false) {
    const result = await git(["branch", "-d", "--", item.branch], repo.root, {
      allowFailure: true,
    });
    branchDeleted = result.code === 0;
    if (!branchDeleted)
      warnings.push(`Worktree удалён, ветка ${item.branch} сохранена: ${result.stderr.trim()}`);
  }
  return { worktreePath: item.worktreePath, branch: item.branch, branchDeleted, warnings };
}
