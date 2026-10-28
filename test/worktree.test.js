import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { GitwtPlugin } from "../src/index.js";
import { createWorktree, listWorktrees, removeWorktree, updateRecord } from "../src/worktree.js";

const bin = fileURLToPath(new URL("../bin/git-wt.js", import.meta.url));
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Тест",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Тест",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    env: identity,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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

test("новая ветка начинается на свежем remote main и не получает upstream", async (t) => {
  const f = await fixture(t);
  const head = git(["rev-parse", "HEAD"], f.repo);
  git(["switch", "-c", "unrelated"], f.repo);
  await writeFile(path.join(f.repo, "local.txt"), "Локальная ветка");
  git(["add", "local.txt"], f.repo);
  git(["commit", "-m", "Локальное изменение"], f.repo);
  const result = await createWorktree(f.repo, { description: "Исправить вход", home: f.home });
  assert.equal(result.branch, "ispravit-vhod");
  assert.equal(result.head, head);
  assert.equal(git(["branch", "--show-current"], result.worktreePath), result.branch);
  assert.throws(() => git(["rev-parse", "--abbrev-ref", "@{upstream}"], result.worktreePath));
  assert.equal((await listWorktrees(f.repo))[1].state.status, "ready");
});

test("fetch обновляет устаревшую remote-tracking ветку до создания worktree", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, "other");
  git(["clone", f.remote, other], f.root);
  await writeFile(path.join(other, "remote.txt"), "Свежий коммит");
  git(["add", "remote.txt"], other);
  git(["commit", "-m", "Обновление remote"], other);
  git(["push", "origin", "main"], other);
  const expected = git(["rev-parse", "HEAD"], other);
  assert.notEqual(git(["rev-parse", "origin/main"], f.repo), expected);
  const created = await createWorktree(f.repo, { branch: "fresh", home: f.home });
  assert.equal(created.head, expected);
  assert.equal(
    await readFile(path.join(created.worktreePath, "remote.txt"), "utf8"),
    "Свежий коммит",
  );
});

test("явный from HEAD работает без remote", async (t) => {
  const f = await fixture(t);
  git(["remote", "remove", "origin"], f.repo);
  const result = await createWorktree(f.repo, { branch: "offline", from: "HEAD", home: f.home });
  assert.equal(result.head, git(["rev-parse", "HEAD"], f.repo));
});

test("повреждённый JSONC и неизвестные настройки не создают worktree", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.repo, ".opencode"));
  await writeFile(path.join(f.repo, ".opencode/gitwt.jsonc"), '{"base":}');
  await assert.rejects(createWorktree(f.repo, { branch: "bad", home: f.home }), {
    code: "invalid_config",
  });
  await writeFile(path.join(f.repo, ".opencode/gitwt.jsonc"), '{"worktreeDirr":"/tmp/wrong"}');
  await assert.rejects(createWorktree(f.repo, { branch: "bad", home: f.home }), {
    code: "invalid_config",
  });
  await writeFile(path.join(f.repo, ".opencode/gitwt.jsonc"), '{"sync":false}');
  await assert.rejects(createWorktree(f.repo, { branch: "bad", home: f.home }), {
    code: "invalid_config",
  });
  assert.equal((await listWorktrees(f.repo)).length, 1);
});

test("точное имя ветки и кастомный путь с пробелами и кавычками сохраняются", async (t) => {
  const f = await fixture(t);
  const worktreePath = path.join(f.root, 'папка "с кавычками"');
  const result = await createWorktree(f.repo, {
    branch: "feature/Login",
    path: worktreePath,
    home: f.home,
  });
  assert.equal(result.branch, "feature/Login");
  assert.equal(result.worktreePath, await realpath(worktreePath));
  await removeWorktree(f.repo, result.branch, { home: f.home });
});

test("конфиг раскрывает ~, CLI переопределяет проектный и глобальный конфиг", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.repo, ".opencode"));
  await writeFile(path.join(f.home, ".git-wt"), "worktree_dir: ~/global\nprefix: global/\n");
  await writeFile(
    path.join(f.repo, ".opencode/gitwt.jsonc"),
    '{"prefix":"project/","worktreeDir":"~/project"}',
  );
  const config = await loadConfig(f.repo, { prefix: "cli/", worktreeDir: "~/cli" }, f.home);
  assert.equal(config.prefix, "cli/");
  assert.equal(config.worktreeDir, path.join(f.home, "cli"));
  const created = await createWorktree(f.repo, {
    branch: "task",
    home: f.home,
    config: { prefix: "cli/", worktreeDir: "~/cli" },
  });
  assert.ok(created.worktreePath.startsWith(path.join(f.home, "cli")));
  assert.equal(created.branch, "cli/task");
});

test("существующую ветку можно подключить только с reuse", async (t) => {
  const f = await fixture(t);
  git(["branch", "feature/existing"], f.repo);
  await assert.rejects(createWorktree(f.repo, { branch: "feature/existing", home: f.home }), {
    code: "branch_exists",
  });
  const result = await createWorktree(f.repo, {
    branch: "feature/existing",
    reuse: true,
    home: f.home,
  });
  assert.equal(result.head, git(["rev-parse", "feature/existing"], f.repo));
});

test("невалидный итоговый prefix не создаёт ветку или каталог", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createWorktree(f.repo, { branch: "task", home: f.home, config: { prefix: "../" } }),
    { code: "invalid_name" },
  );
  assert.equal((await listWorktrees(f.repo)).length, 1);
});

test("lease нельзя обойти отсутствием owner или флагом force, состояние не загрязняет git", async (t) => {
  const f = await fixture(t);
  const result = await createWorktree(f.repo, { branch: "leased", owner: "agent-1", home: f.home });
  assert.equal(git(["status", "--porcelain"], result.worktreePath), "");
  await assert.rejects(removeWorktree(f.repo, result.branch, { home: f.home }), {
    code: "lease_conflict",
  });
  await assert.rejects(
    removeWorktree(f.repo, result.branch, { owner: "agent-2", force: true, home: f.home }),
    { code: "lease_conflict" },
  );
  const removed = await removeWorktree(f.repo, result.branch, { owner: "agent-1", home: f.home });
  assert.equal(removed.branchDeleted, true);
});

test("dirty worktree сохраняется без force; явный force удаляет без автокоммита", async (t) => {
  const f = await fixture(t);
  const result = await createWorktree(f.repo, { branch: "dirty", home: f.home });
  await writeFile(path.join(result.worktreePath, "unsaved.txt"), "Не сохранено");
  await assert.rejects(removeWorktree(f.repo, result.branch, { home: f.home }), {
    code: "worktree_dirty",
  });
  const listed = await listWorktrees(f.repo, { status: true });
  assert.equal(listed.find((entry) => entry.branch === "dirty").dirty, true);
  const before = git(["rev-list", "--all", "--count"], f.repo);
  await removeWorktree(f.repo, result.branch, { force: true, home: f.home });
  assert.equal(git(["rev-list", "--all", "--count"], f.repo), before);
});

test("preRemove, создавший изменения, останавливает удаление", async (t) => {
  const f = await fixture(t);
  const created = await createWorktree(f.repo, { branch: "hook", home: f.home });
  const config = {
    hooks: {
      preRemove: [[process.execPath, "-e", 'require("fs").writeFileSync("hook.txt", "Изменение")']],
    },
  };
  await assert.rejects(removeWorktree(f.repo, created.branch, { home: f.home, config }), {
    code: "worktree_dirty",
  });
  assert.equal(await readFile(path.join(created.worktreePath, "hook.txt"), "utf8"), "Изменение");
});

test("неслитая ветка сохраняется с предупреждением, слитая удаляется", async (t) => {
  const f = await fixture(t);
  const created = await createWorktree(f.repo, { branch: "unmerged", home: f.home });
  await writeFile(path.join(created.worktreePath, "feature.txt"), "Фича");
  git(["add", "."], created.worktreePath);
  git(["commit", "-m", "Фича"], created.worktreePath);
  const removed = await removeWorktree(f.repo, created.branch, { home: f.home });
  assert.equal(removed.branchDeleted, false);
  assert.ok(removed.warning);
  git(["merge", "--ff-only", "unmerged"], f.repo);
  const again = await createWorktree(f.repo, { branch: "unmerged", reuse: true, home: f.home });
  assert.equal((await removeWorktree(f.repo, again.branch, { home: f.home })).branchDeleted, true);
});

test("ошибка setup сохраняет worktree и явное состояние ошибки", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createWorktree(f.repo, {
      branch: "failed",
      home: f.home,
      config: { setup: [process.execPath, "-e", "process.exit(9)"] },
    }),
    { code: "setup_failed" },
  );
  const items = await listWorktrees(f.repo);
  assert.equal(items.find((item) => item.branch === "failed").state.status, "setup_failed");
});

test("параллельное создание и обновление записей не теряет lease", async (t) => {
  const f = await fixture(t);
  const created = await Promise.all(
    ["one", "two"].map((branch) => createWorktree(f.repo, { branch, owner: branch, home: f.home })),
  );
  await Promise.all(
    created.map((item) =>
      updateRecord(f.repo, item.worktreePath, { sessionId: `ses_${item.branch}` }, item.owner),
    ),
  );
  const items = await listWorktrees(f.repo);
  assert.deepEqual(
    items
      .filter((item) => item.state)
      .map((item) => item.state.sessionId)
      .sort(),
    ["ses_one", "ses_two"],
  );
});

test("CLI возвращает exit 0 и чистый JSON с корректным экранированием", async (t) => {
  const f = await fixture(t);
  const output = execFileSync(
    process.execPath,
    [bin, "--json", "--slug", "cli", "--path", path.join(f.root, 'my "worktree"')],
    { cwd: f.repo, env: { ...identity, HOME: f.home }, encoding: "utf8" },
  );
  assert.equal(JSON.parse(output).ok, true);
  const listed = JSON.parse(
    execFileSync(process.execPath, [bin, "list", "--json", "--status"], {
      cwd: f.repo,
      env: identity,
      encoding: "utf8",
    }),
  );
  assert.equal(listed.worktrees.length, 2);
  const text = execFileSync(
    process.execPath,
    [bin, "без lease", "--from", "HEAD", "--path", path.join(f.root, "text-output")],
    { cwd: f.repo, env: { ...identity, HOME: f.home }, encoding: "utf8" },
  );
  assert.equal(JSON.parse(text).branch, "bez-lease");
});

test("плагин не удаляет worktree по idle чужой сессии и поддерживает две pending-операции", async (t) => {
  const f = await fixture(t);
  const oldHome = process.env.HOME;
  process.env.HOME = f.home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  });
  const logs = [];
  const client = {
    app: {
      log: async (entry) => {
        logs.push(entry);
      },
    },
  };
  const pluginOptions = {
    terminal: "none",
    forkSession: false,
    worktreeDir: path.join(f.root, "trees"),
  };
  const plugin = await GitwtPlugin(
    { client, project: { id: "project" }, directory: f.repo },
    pluginOptions,
  );
  const contexts = ["one", "two"].map((sessionID) => ({
    directory: f.repo,
    sessionID,
    abort: new AbortController().signal,
  }));
  const created = [];
  for (const context of contexts) {
    const result = JSON.parse(
      await plugin.tool.gitwt_create.execute({ branch: context.sessionID, open: false }, context),
    );
    assert.equal(result.ok, true, result.error);
    created.push(result);
  }
  for (let index = 0; index < contexts.length; index += 1) {
    const context = { ...contexts[index], directory: created[index].worktreePath };
    const result = JSON.parse(
      await plugin.tool.gitwt_remove.execute({ branch: context.sessionID }, context),
    );
    assert.equal(result.pending, true);
  }
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "other" } } });
  await plugin.event({ event: { type: "session.idle", properties: {} } });
  assert.equal((await listWorktrees(f.repo)).length, 3);
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "one" } } });
  assert.deepEqual((await listWorktrees(f.repo)).map((item) => item.branch).sort(), [
    "main",
    "two",
  ]);
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "two" } } });
  assert.equal((await listWorktrees(f.repo)).length, 1);
  assert.equal(logs.length, 0);
});

test("ошибка отложенного удаления сохраняет worktree и снимает только pending-флаг", async (t) => {
  const f = await fixture(t);
  const result = await createWorktree(f.repo, {
    branch: "pending",
    owner: "session",
    home: f.home,
  });
  await updateRecord(
    f.repo,
    result.worktreePath,
    { pendingRemove: { sessionId: "session", owner: "session" } },
    "session",
  );
  await writeFile(path.join(result.worktreePath, "unsaved.txt"), "Не удалять");
  const plugin = await GitwtPlugin({
    client: { app: { log: async () => {} } },
    project: { id: "project" },
    directory: f.repo,
  });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session" } } });
  const record = (await listWorktrees(f.repo)).find((item) => item.branch === "pending").state;
  assert.equal(record.pendingRemove, null);
  assert.equal(record.status, "remove_failed");
  assert.equal(await readFile(path.join(result.worktreePath, "unsaved.txt"), "utf8"), "Не удалять");
});

test("ошибка Git после checkout не оставляет worktree без lease", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 9\n", {
    mode: 0o755,
  });
  await assert.rejects(
    createWorktree(f.repo, { branch: "partial", owner: "agent", home: f.home }),
    { code: "worktree_create_failed" },
  );
  const item = (await listWorktrees(f.repo)).find((entry) => entry.branch === "partial");
  assert.equal(item.state.owner, "agent");
  assert.equal(item.state.status, "verification_failed");
  await assert.rejects(removeWorktree(f.repo, "partial", { home: f.home }), {
    code: "lease_conflict",
  });
});

test("удаление использует preRemove из настроек создания worktree", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "removed.txt");
  const created = await createWorktree(f.repo, {
    branch: "snapshot-hooks",
    home: f.home,
    config: {
      hooks: {
        preRemove: [
          [
            process.execPath,
            "-e",
            `require("fs").writeFileSync(${JSON.stringify(marker)}, "Исходный хук")`,
          ],
        ],
      },
    },
  });
  await removeWorktree(f.repo, created.branch, { home: f.home });
  assert.equal(await readFile(marker, "utf8"), "Исходный хук");
});

test("команда запуска плагина сохраняет бинарник и профиль OCX", async (t) => {
  const f = await fixture(t);
  const previous = Object.fromEntries(
    ["OCX_CONTEXT", "OCX_BIN", "OCX_PROFILE", "HOME"].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    HOME: f.home,
    OCX_CONTEXT: "1",
    OCX_BIN: process.execPath,
    OCX_PROFILE: "profile",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const plugin = await GitwtPlugin(
    { client: {}, project: { id: "project" }, directory: f.repo },
    { terminal: "none", forkSession: false, worktreeDir: path.join(f.root, "trees") },
  );
  const result = JSON.parse(
    await plugin.tool.gitwt_create.execute(
      { branch: "ocx", open: false },
      { sessionID: "session", directory: f.repo },
    ),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.command, [process.execPath, "opencode", "-p", "profile"]);
});
