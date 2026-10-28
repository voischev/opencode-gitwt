import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { GitwtPlugin } from "../src/index.js";
import {
  createWorktree,
  inspectHooks,
  listWorktrees,
  removeWorktree,
  resolveWorktree,
} from "../src/worktree.js";

const bin = fileURLToPath(new URL("../bin/git-wt.js", import.meta.url));
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Тест",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Тест",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
};
const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    env: identity,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const command = (script) => [process.execPath, "-e", script];

async function fixture(t) {
  const base = path.join(os.tmpdir(), "opencode");
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(base, "gitwt-core-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "project");
  const remote = path.join(root, "remote.git");
  const home = path.join(root, "home");
  await mkdir(home);
  git(["init", "--bare", "--initial-branch=main", remote], root);
  git(["clone", remote, repo], root);
  await writeFile(path.join(repo, "README.md"), "Начало\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "Начало"], repo);
  git(["push", "origin", "main"], repo);
  return { root, repo, home, remote };
}

test("создаёт новую ветку от свежей remote-базы, не меняя грязный исходный checkout", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, "other");
  git(["clone", f.remote, other], f.root);
  await writeFile(path.join(other, "remote.txt"), "Свежий коммит");
  git(["add", "."], other);
  git(["commit", "-m", "Обновление"], other);
  git(["push", "origin", "main"], other);
  git(["switch", "-c", "current-task"], f.repo);
  await writeFile(path.join(f.repo, "unsaved.txt"), "Исходные изменения");
  const created = await createWorktree(f.repo, { branch: "feature/Login", home: f.home });
  assert.equal(created.head, git(["rev-parse", "HEAD"], other));
  assert.equal(git(["branch", "--show-current"], created.worktreePath), "feature/Login");
  assert.equal(git(["branch", "--show-current"], f.repo), "current-task");
  assert.equal(await readFile(path.join(f.repo, "unsaved.txt"), "utf8"), "Исходные изменения");
  assert.equal(git(["status", "--porcelain"], created.worktreePath), "");
  assert.throws(() => git(["rev-parse", "@{upstream}"], created.worktreePath));
});

test("локальная база работает без remote; существующая ветка и неверный prefix отклоняются", async (t) => {
  const f = await fixture(t);
  git(["remote", "remove", "origin"], f.repo);
  const created = await createWorktree(f.repo, { branch: "local", from: "HEAD", home: f.home });
  assert.equal(created.head, git(["rev-parse", "HEAD"], f.repo));
  await assert.rejects(createWorktree(f.repo, { branch: "local", from: "HEAD", home: f.home }), {
    code: "branch_exists",
  });
  await assert.rejects(
    createWorktree(f.repo, {
      branch: "bad",
      from: "HEAD",
      home: f.home,
      config: { prefix: "../" },
    }),
    { code: "invalid_name" },
  );
});

test("список и поиск используют реестр Git, включая вручную созданные worktree", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'my "worktree"');
  git(["worktree", "add", "-b", "manual", target], f.repo);
  assert.equal((await listWorktrees(f.repo)).length, 2);
  assert.equal((await resolveWorktree(f.repo, "manual")).worktreePath, target);
  assert.equal((await resolveWorktree(f.repo, target)).branch, "manual");
  assert.deepEqual(await inspectHooks(f.repo, "manual"), {
    worktreePath: target,
    snapshot: "absent",
    postCreate: "unknown",
    preRemove: "unknown",
  });
  await assert.rejects(resolveWorktree(f.repo, "missing"), { code: "worktree_missing" });
});

test("конфиг объединяет global/project/аргументы и сохраняет независимые списки хуков", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, ".config/opencode"), { recursive: true });
  await mkdir(path.join(f.repo, ".opencode"));
  await writeFile(
    path.join(f.home, ".config/opencode/gitwt.jsonc"),
    '{"prefix":"global/","hooks":{"postCreate":["true"]}}',
  );
  await writeFile(
    path.join(f.repo, ".opencode/gitwt.jsonc"),
    '{"prefix":"project/","hooks":{"preRemove":["true"]}}',
  );
  const config = await loadConfig(f.repo, { prefix: "cli/", worktreeDir: "~/copies" }, f.home);
  assert.equal(config.prefix, "cli/");
  assert.equal(config.worktreeDir, path.join(f.home, "copies"));
  assert.deepEqual(config.hooks, { postCreate: ["true"], preRemove: ["true"] });
  await writeFile(path.join(f.repo, ".opencode/gitwt.jsonc"), '{"base":}');
  await assert.rejects(loadConfig(f.repo, {}, f.home), { code: "invalid_config" });
});

test("занятый путь не перезаписывается, пробелы и кавычки в новом пути сохраняются", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'my "copy"');
  const created = await createWorktree(f.repo, {
    branch: "spaces",
    path: target,
    from: "HEAD",
    home: f.home,
  });
  assert.equal(created.worktreePath, target);
  await assert.rejects(
    createWorktree(f.repo, { branch: "other", path: target, from: "HEAD", home: f.home }),
    { code: "worktree_exists" },
  );
  assert.equal((await resolveWorktree(f.repo, target)).branch, "spaces");
});

test("хуки получают окружение, а preRemove сохраняется независимо от нового конфига", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "marker.json");
  const removed = path.join(f.root, "removed.txt");
  const created = await createWorktree(f.repo, {
    branch: "hooks",
    from: "HEAD",
    home: f.home,
    config: {
      hooks: {
        postCreate: [
          command(
            `require("fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({branch:process.env.BRANCH,path:process.env.WORKTREE_PATH,head:process.env.HEAD,source:process.env.SOURCE_PATH}))`,
          ),
        ],
        preRemove: [
          command(`require("fs").writeFileSync(${JSON.stringify(removed)}, "Сохранённый хук")`),
        ],
      },
    },
  });
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
    branch: "hooks",
    path: created.worktreePath,
    head: created.head,
    source: f.repo,
  });
  await mkdir(path.join(f.repo, ".opencode"));
  await writeFile(path.join(f.repo, ".opencode/gitwt.jsonc"), '{"hooks":{"preRemove":["exit 9"]}}');
  await removeWorktree(f.repo, "hooks");
  assert.equal(await readFile(removed, "utf8"), "Сохранённый хук");
});

test("noHooks сохраняет явное отключение, а ошибка postCreate оставляет worktree с предупреждением", async (t) => {
  const f = await fixture(t);
  const config = {
    hooks: { postCreate: [command("process.exit(9)")], preRemove: [command("process.exit(9)")] },
  };
  const disabled = await createWorktree(f.repo, {
    branch: "disabled",
    from: "HEAD",
    noHooks: true,
    home: f.home,
    config,
  });
  assert.deepEqual(disabled.warnings, []);
  assert.equal((await inspectHooks(f.repo, "disabled")).preRemove, "none");
  await removeWorktree(f.repo, "disabled");
  const failed = await createWorktree(f.repo, {
    branch: "post-failed",
    from: "HEAD",
    home: f.home,
    config,
  });
  assert.equal(failed.warnings.length, 1);
  assert.equal((await resolveWorktree(f.repo, "post-failed")).head, failed.head);
  await assert.rejects(removeWorktree(f.repo, "post-failed", { force: true }), {
    code: "command_failed",
  });
});

test("dirty и изменения preRemove блокируют удаление; force не обходит ошибку хука", async (t) => {
  const f = await fixture(t);
  const created = await createWorktree(f.repo, { branch: "dirty", from: "HEAD", home: f.home });
  await writeFile(path.join(created.worktreePath, "unsaved.txt"), "Не сохранено");
  await assert.rejects(removeWorktree(f.repo, "dirty"), { code: "worktree_dirty" });
  assert.equal(
    (await listWorktrees(f.repo, { status: true })).find((item) => item.branch === "dirty").dirty,
    true,
  );
  const before = git(["rev-list", "--all", "--count"], f.repo);
  await removeWorktree(f.repo, "dirty", { force: true });
  assert.equal(git(["rev-list", "--all", "--count"], f.repo), before);
  const hooked = await createWorktree(f.repo, {
    branch: "hooked",
    from: "HEAD",
    home: f.home,
    config: {
      hooks: { preRemove: [command('require("fs").writeFileSync("new.txt", "Изменение")')] },
    },
  });
  await assert.rejects(removeWorktree(f.repo, "hooked"), { code: "worktree_dirty" });
  assert.equal(await readFile(path.join(hooked.worktreePath, "new.txt"), "utf8"), "Изменение");
});

test("текущий checkout защищён; неслитая ветка сохраняется, слитая удаляется", async (t) => {
  const f = await fixture(t);
  await assert.rejects(removeWorktree(f.repo, "main", { force: true }), {
    code: "protected_worktree",
  });
  const created = await createWorktree(f.repo, { branch: "feature", from: "HEAD", home: f.home });
  await assert.rejects(removeWorktree(created.worktreePath, "feature"), {
    code: "protected_worktree",
  });
  await writeFile(path.join(created.worktreePath, "feature.txt"), "Фича");
  git(["add", "."], created.worktreePath);
  git(["commit", "-m", "Фича"], created.worktreePath);
  const result = await removeWorktree(f.repo, "feature");
  assert.equal(result.branchDeleted, false);
  assert.equal(result.warnings.length, 1);
  git(["merge", "--ff-only", "feature"], f.repo);
  const merged = await createWorktree(f.repo, { branch: "merged", from: "HEAD", home: f.home });
  assert.equal((await removeWorktree(f.repo, merged.worktreePath)).branchDeleted, true);
});

test("ошибки checkout и повреждённые снимки не приводят к автоматическому удалению", async (t) => {
  const f = await fixture(t);
  const created = await createWorktree(f.repo, { branch: "snapshot", from: "HEAD", home: f.home });
  const snapshot = git(
    ["rev-parse", "--path-format=absolute", "--git-path", "opencode-gitwt-hooks.json"],
    created.worktreePath,
  );
  await writeFile(snapshot, "{");
  await assert.rejects(removeWorktree(f.repo, "snapshot", { force: true }), {
    code: "invalid_hooks",
  });
  await writeFile(path.join(f.repo, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 9\n", {
    mode: 0o755,
  });
  await assert.rejects(createWorktree(f.repo, { branch: "partial", from: "HEAD", home: f.home }), {
    code: "worktree_create_failed",
  });
  assert.equal((await listWorktrees(f.repo)).length, 3);
});

test("CLI add/list/cd выдаёт чистый машинный вывод, не меняя cwd вызывающего процесса", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.repo, ".opencode"));
  await writeFile(
    path.join(f.repo, ".opencode/gitwt.jsonc"),
    JSON.stringify({ hooks: { postCreate: [command('process.stdout.write("Вывод хука\\n")')] } }),
  );
  const target = path.join(f.root, "CLI worktree");
  const env = { ...identity, HOME: f.home };
  const invoke = (args) =>
    execFileSync(process.execPath, [bin, ...args], { cwd: f.repo, env, encoding: "utf8" });
  const receipt = JSON.parse(invoke(["add", "cli", "--from", "HEAD", "--path", target, "--json"]));
  assert.equal(receipt.worktreePath, target);
  assert.equal(invoke(["cd", "cli"]), `${target}\n`);
  assert.equal(JSON.parse(invoke(["list", "--porcelain"])).length, 2);
  assert.equal(git(["branch", "--show-current"], f.repo), "main");
});

test("обёртка OpenCode возвращает путь и работает без клиента, сессий и idle-хуков", async (t) => {
  const f = await fixture(t);
  const plugin = await GitwtPlugin(
    { directory: f.repo },
    { worktreeDir: path.join(f.root, "copies") },
  );
  const ctx = { directory: f.repo, sessionID: "same-session", abort: new AbortController().signal };
  const before = process.cwd();
  const receipt = JSON.parse(
    await plugin.tool.gitwt_create.execute({ branch: "agent", from: "HEAD", noHooks: true }, ctx),
  );
  const found = JSON.parse(await plugin.tool.gitwt_cd.execute({ target: "agent" }, ctx));
  assert.equal(found.worktreePath, receipt.worktreePath);
  assert.equal(ctx.directory, f.repo);
  assert.equal(ctx.sessionID, "same-session");
  assert.equal(process.cwd(), before);
  assert.equal(plugin.event, undefined);
  assert.equal((await listWorktrees(f.repo)).length, 2);
  const removed = JSON.parse(await plugin.tool.gitwt_remove.execute({ target: "agent" }, ctx));
  assert.equal(removed.branchDeleted, true);
});
