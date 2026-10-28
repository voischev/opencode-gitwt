import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { expandPath, loadConfig } from "./config.js";
import { prepareEnvironment, runHooks } from "./environment.js";
import { GitwtError, git } from "./process.js";

export async function repository(cwd) {
  const root = await git(["rev-parse", "--show-toplevel"], cwd);
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  const commonDir = await realpath(common.stdout.trim());
  return {
    root: await realpath(root.stdout.trim()),
    commonDir,
    stateDir: path.join(commonDir, "opencode-gitwt"),
    id: createHash("sha256").update(commonDir).digest("hex").slice(0, 12),
  };
}

async function locked(repo, fn) {
  await mkdir(repo.stateDir, { recursive: true });
  let release;
  try {
    release = await lockfile.lock(repo.stateDir, {
      retries: { retries: 60, minTimeout: 100, maxTimeout: 100 },
      stale: 300_000,
      update: 10_000,
    });
  } catch (error) {
    throw new GitwtError(
      "repository_locked",
      `Репозиторий занят другой операцией: ${error.message}`,
    );
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

function recordFile(repo, worktreePath) {
  const key = createHash("sha256").update(path.resolve(worktreePath)).digest("hex");
  return path.join(repo.stateDir, `${key}.json`);
}

async function readRecord(repo, worktreePath) {
  try {
    return JSON.parse(await readFile(recordFile(repo, worktreePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new GitwtError(
      "state_read_failed",
      `Не удалось прочитать состояние worktree: ${error.message}`,
    );
  }
}

async function writeRecord(repo, record) {
  const file = recordFile(repo, record.worktreePath);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function updateRecord(cwd, worktreePath, changes, owner) {
  const repo = await repository(cwd);
  return locked(repo, async () => {
    const record = await readRecord(repo, worktreePath);
    if (!record) throw new GitwtError("state_missing", "Worktree не управляется opencode-gitwt");
    checkOwner(record, owner);
    const next = {
      ...record,
      ...changes,
      branch: record.branch,
      worktreePath: record.worktreePath,
    };
    await writeRecord(repo, next);
    return next;
  });
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

async function worktrees(repo) {
  return parseWorktrees((await git(["worktree", "list", "--porcelain", "-z"], repo.root)).stdout);
}

export async function listWorktrees(cwd, options = {}) {
  const repo = await repository(cwd);
  const items = await worktrees(repo);
  for (const item of items) {
    item.state = await readRecord(repo, item.worktreePath);
    if (options.status && !item.prunable && !item.bare) {
      item.dirty = Boolean((await git(["status", "--porcelain", "-z"], item.worktreePath)).stdout);
      const comparison = await git(
        ["rev-list", "--left-right", "--count", `HEAD...${item.state?.baseRef ?? "@{upstream}"}`],
        item.worktreePath,
        { allowFailure: true },
      );
      if (comparison.code === 0) {
        [item.ahead, item.behind] = comparison.stdout.trim().split(/\s+/).map(Number);
      }
    }
  }
  return items;
}

const transliteration = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function slugify(description) {
  const latin = [...description.toLowerCase()]
    .map((char) => transliteration[char] ?? char)
    .join("");
  return latin
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

async function validBranch(branch, repo) {
  if (!branch || branch.startsWith("-") || branch.includes("@{")) {
    throw new GitwtError("invalid_name", `Недопустимое имя ветки: ${branch}`);
  }
  const result = await git(["check-ref-format", `refs/heads/${branch}`], repo.root, {
    allowFailure: true,
  });
  if (result.code !== 0) throw new GitwtError("invalid_name", `Недопустимое имя ветки: ${branch}`);
}

async function retryGit(args, cwd, signal) {
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await git(args, cwd, { allowFailure: true, signal });
    if (last.code === 0) return last;
    signal?.throwIfAborted();
  }
  throw new GitwtError(
    "fetch_failed",
    `Git ${args[0]} завершился с ошибкой после двух попыток: ${last.stderr.trim()}`,
  );
}

async function baseReference(repo, config, options) {
  if (options.from) {
    if (options.from.startsWith("-"))
      throw new GitwtError("invalid_base", "Недопустимая стартовая ссылка");
    const result = await git(["rev-parse", "--verify", `${options.from}^{commit}`], repo.root, {
      signal: options.signal,
    });
    return { base: options.from, baseRef: result.stdout.trim() };
  }
  let base = config.base;
  if (base === "auto") {
    const refs = await retryGit(
      ["ls-remote", "--heads", config.remote, "trunk", "main", "master"],
      repo.root,
      options.signal,
    );
    base = ["trunk", "main", "master"].find((name) =>
      refs.stdout.split("\n").some((line) => line.endsWith(`refs/heads/${name}`)),
    );
    if (!base) {
      const head = await retryGit(
        ["ls-remote", "--symref", config.remote, "HEAD"],
        repo.root,
        options.signal,
      );
      base = head.stdout.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
    }
  }
  if (!base)
    throw new GitwtError("base_missing", "Не удалось определить базовую ветку; укажите --base");
  await validBranch(base, repo);
  const baseRef = `refs/remotes/${config.remote}/${base}`;
  await retryGit(
    ["fetch", "--no-tags", config.remote, `${base}:${baseRef}`],
    repo.root,
    options.signal,
  );
  return { base, baseRef };
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function createWorktree(cwd, options = {}) {
  const repo = await repository(cwd);
  const home = options.home ?? os.homedir();
  const config = await loadConfig(repo.root, options.config, home);
  const branch = `${config.prefix}${options.branch ?? slugify(options.description ?? "")}`;
  await validBranch(branch, repo);
  return locked(repo, async () => {
    const items = await worktrees(repo);
    const mainPath = items[0].worktreePath;
    const name = `${path.basename(mainPath)}-${repo.id}`;
    const relative = path.relative(home, mainPath);
    const defaultPath =
      relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
        ? relative
        : name;
    const target = options.path
      ? expandPath(options.path, home, repo.root)
      : path.join(
          config.worktreeDir
            ? path.join(config.worktreeDir, name)
            : path.join(home, "git-wt", defaultPath),
          branch,
        );
    if (
      (await exists(target)) ||
      items.some((item) => path.resolve(item.worktreePath) === target)
    ) {
      throw new GitwtError("worktree_exists", `Путь уже занят: ${target}`);
    }
    const branchExists =
      (
        await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo.root, {
          allowFailure: true,
        })
      ).code === 0;
    if (branchExists && !options.reuse)
      throw new GitwtError("branch_exists", `Ветка ${branch} уже существует; укажите --reuse`);
    if (!branchExists && options.reuse)
      throw new GitwtError("branch_missing", `Ветка ${branch} не существует`);
    const base = branchExists
      ? { base: branch, baseRef: `refs/heads/${branch}` }
      : await baseReference(repo, config, options);
    const expected = (
      await git(["rev-parse", "--verify", `${base.baseRef}^{commit}`], repo.root)
    ).stdout.trim();
    await mkdir(path.dirname(target), { recursive: true });
    const worktreePath = path.join(await realpath(path.dirname(target)), path.basename(target));
    const record = {
      branch,
      worktreePath,
      sourceDirectory: repo.root,
      preRemove: config.hooks.preRemove,
      remote: config.remote,
      ...base,
      head: expected,
      owner: options.owner ?? null,
      reason: options.reason ?? "",
      createdAt: new Date().toISOString(),
      status: "creating",
      sessionId: null,
    };
    await writeRecord(repo, record);
    try {
      await git(
        branchExists
          ? ["worktree", "add", "--", worktreePath, branch]
          : ["worktree", "add", "--no-track", "-b", branch, "--", worktreePath, expected],
        repo.root,
        { signal: options.signal },
      );
      const actualBranch = (await git(["branch", "--show-current"], worktreePath)).stdout.trim();
      const head = (await git(["rev-parse", "HEAD"], worktreePath)).stdout.trim();
      const registered = (await worktrees(repo)).some(
        (item) => item.worktreePath === worktreePath && item.branch === branch,
      );
      if (actualBranch !== branch || head !== expected || !registered) {
        throw new GitwtError(
          "verification_failed",
          "Проверка ветки, HEAD или регистрации не прошла",
        );
      }
      record.status = "preparing";
      await writeRecord(repo, record);
    } catch (error) {
      const registered = (await worktrees(repo)).some((item) => item.worktreePath === worktreePath);
      if (registered) {
        record.status = "verification_failed";
        await writeRecord(repo, record);
      } else {
        await rm(recordFile(repo, worktreePath), { force: true });
      }
      throw new GitwtError(
        "worktree_create_failed",
        `Создание ${worktreePath} завершилось ошибкой: ${error.message}`,
        { worktreePath },
      );
    }
    try {
      await prepareEnvironment(repo.root, worktreePath, config, {
        signal: options.signal,
        env: { BRANCH: branch, WORKTREE_PATH: worktreePath, HEAD: expected },
      });
      record.status = "ready";
      await writeRecord(repo, record);
    } catch (error) {
      record.status = "setup_failed";
      await writeRecord(repo, record);
      throw new GitwtError(
        "setup_failed",
        `Worktree сохранён в ${worktreePath}; подготовка окружения завершилась ошибкой: ${error.message}`,
        { worktreePath, cause: error.code },
      );
    }
    return { ...record, config };
  });
}

function checkOwner(record, owner) {
  if (record?.owner && record.owner !== owner) {
    throw new GitwtError(
      "lease_conflict",
      `Worktree принадлежит ${record.owner}; требуется совпадающий --lease-owner`,
    );
  }
}

export async function removeWorktree(cwd, branch, options = {}) {
  const repo = await repository(cwd);
  const config = await loadConfig(repo.root, options.config, options.home);
  await validBranch(branch, repo);
  return locked(repo, async () => {
    const items = await worktrees(repo);
    const item = items.find((entry) => entry.branch === branch);
    if (!item) throw new GitwtError("worktree_missing", `Worktree для ветки ${branch} не найден`);
    if (item === items[0] || item.worktreePath === repo.root) {
      throw new GitwtError(
        "protected_worktree",
        "Нельзя удалить основной или текущий worktree; запустите удаление из другого worktree",
      );
    }
    const record = await readRecord(repo, item.worktreePath);
    checkOwner(record, options.owner);
    const env = { BRANCH: branch, WORKTREE_PATH: item.worktreePath, HEAD: item.head };
    const assertClean = async () => {
      if (
        !options.force &&
        (await git(["status", "--porcelain", "-z"], item.worktreePath)).stdout
      ) {
        throw new GitwtError(
          "worktree_dirty",
          "Worktree содержит изменения; явный --force удалит их",
        );
      }
    };
    await assertClean();
    const hooks = options.config?.hooks?.preRemove ?? record?.preRemove ?? config.hooks.preRemove;
    await runHooks(hooks, item.worktreePath, env, options.signal);
    await assertClean();
    await git(
      ["worktree", "remove", ...(options.force ? ["--force"] : []), "--", item.worktreePath],
      repo.root,
      { signal: options.signal },
    );
    await rm(recordFile(repo, item.worktreePath), { force: true });
    let branchDeleted = false;
    let warning;
    if (options.deleteBranch !== false) {
      const result = await git(["branch", "-d", "--", branch], repo.root, { allowFailure: true });
      branchDeleted = result.code === 0;
      if (!branchDeleted)
        warning = `Worktree удалён, ветка ${branch} сохранена: ${result.stderr.trim()}`;
    }
    return {
      branch,
      worktreePath: item.worktreePath,
      branchDeleted,
      ...(warning ? { warning } : {}),
    };
  });
}
