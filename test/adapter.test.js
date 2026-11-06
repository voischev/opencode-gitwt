import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pluginModule, { GitwtPlugin } from "../src/index.js";

test("адаптер создаёт, находит и удаляет worktree через gitwt", async (t) => {
  const base = path.join(os.tmpdir(), "opencode");
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(base, "gitwt-adapter-")));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Тест",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Тест",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (args, cwd = repo) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  git(["init", "-b", "main"]);
  await writeFile(path.join(repo, "README.md"), "Начало\n");
  git(["add", "README.md"]);
  git(["commit", "-m", "Начало"]);

  const plugin = await GitwtPlugin({ directory: repo }, { worktreeDir: path.join(root, "copies") });
  const ctx = {
    directory: repo,
    sessionID: "same-session",
    abort: new AbortController().signal,
  };
  const before = process.cwd();
  const created = JSON.parse(
    await plugin.tool.gitwt_create.execute({ branch: "feature/main", from: "HEAD" }, ctx),
  );
  assert.equal(created.branch, "feature/main");
  assert.equal(git(["branch", "--show-current"], created.worktreePath), "feature/main");
  assert.equal(created.head, git(["rev-parse", "HEAD"]));

  const found = JSON.parse(await plugin.tool.gitwt_cd.execute({ target: "feature/main" }, ctx));
  assert.equal(found.worktreePath, created.worktreePath);
  const listed = JSON.parse(await plugin.tool.gitwt_list.execute({ status: true }, ctx));
  assert.equal(listed.find((item) => item.branch === "feature/main").dirty, false);

  await assert.rejects(plugin.tool.gitwt_create.execute({}, ctx), { code: "invalid_arguments" });
  await assert.rejects(plugin.tool.gitwt_list.execute({ status: "true" }, ctx), {
    code: "invalid_arguments",
  });
  await assert.rejects(plugin.tool.gitwt_cd.execute({ target: null }, ctx), {
    code: "invalid_arguments",
  });
  await assert.rejects(plugin.tool.gitwt_list.execute({ unknown: true }, ctx), {
    code: "invalid_arguments",
  });
  const unsaved = path.join(created.worktreePath, "unsaved.txt");
  await writeFile(unsaved, "Сохранить изменения");
  await assert.rejects(
    plugin.tool.gitwt_remove.execute({ target: "feature/main", force: "false" }, ctx),
    { code: "invalid_arguments" },
  );
  assert.equal(await readFile(unsaved, "utf8"), "Сохранить изменения");
  await assert.rejects(
    plugin.tool.gitwt_remove.execute({ target: "feature/main", force: false }, ctx),
    { code: "worktree_dirty" },
  );
  await rm(unsaved);

  const removed = JSON.parse(
    await plugin.tool.gitwt_remove.execute({ target: "feature/main" }, ctx),
  );
  assert.equal(removed.worktreePath, created.worktreePath);
  assert.equal(JSON.parse(await plugin.tool.gitwt_list.execute({}, ctx)).length, 1);
  assert.equal(ctx.directory, repo);
  assert.equal(ctx.sessionID, "same-session");
  assert.equal(process.cwd(), before);
  assert.equal(plugin.event, undefined);
});

test("адаптер V2 регистрирует общие схемы и передаёт отмену до Git-операций", async () => {
  const tools = new Map();
  await pluginModule.setup({
    location: { directory: "/not-a-repository" },
    options: {},
    tool: {
      transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }),
    },
  });
  assert.equal(tools.size, 4);
  assert.deepEqual(tools.get("gitwt_create").input.required, ["branch"]);
  assert.equal(tools.get("gitwt_remove").options.codemode, false);
  await assert.rejects(
    tools
      .get("gitwt_remove")
      .execute({ target: "task", force: "false" }, { signal: new AbortController().signal }),
    { code: "invalid_arguments" },
  );
  const controller = new AbortController();
  const reason = new Error("Отмена до выполнения");
  controller.abort(reason);
  await assert.rejects(
    tools.get("gitwt_create").execute({ branch: "task" }, { signal: controller.signal }),
    reason,
  );
});
