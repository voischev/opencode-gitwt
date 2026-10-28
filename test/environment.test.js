import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareEnvironment, runHooks } from "../src/environment.js";
import { GitwtError } from "../src/process.js";

const TEMP_BASE = process.env.GITWT_TEST_TMP ?? path.join(os.tmpdir(), "opencode");

function createRoot() {
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  return fs.mkdtempSync(path.join(TEMP_BASE, "gitwt-env-"));
}

function createSourceTarget(root) {
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  return { source, target };
}

function expectCode(code) {
  return (error) => error instanceof GitwtError && error.code === code;
}

test("копирует файлы и каталоги, применяя exclude", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  fs.mkdirSync(path.join(source, "sub"));
  fs.mkdirSync(path.join(source, "node_modules"));
  fs.writeFileSync(path.join(source, "keep.txt"), "keep");
  fs.writeFileSync(path.join(source, "skip.log"), "log");
  fs.writeFileSync(path.join(source, "sub", "inner.txt"), "inner");
  fs.writeFileSync(path.join(source, "sub", "debug.log"), "debug");
  fs.writeFileSync(path.join(source, "node_modules", "dep.js"), "dep");

  await prepareEnvironment(source, target, {
    sync: {
      copyFiles: ["keep.txt", "skip.log", "sub", "node_modules"],
      symlinkDirs: [],
      exclude: ["**/*.log", "node_modules"],
    },
  });

  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(target, "sub", "inner.txt"), "utf8"), "inner");
  assert.equal(fs.existsSync(path.join(target, "skip.log")), false);
  assert.equal(fs.existsSync(path.join(target, "sub", "debug.log")), false);
  assert.equal(fs.existsSync(path.join(target, "node_modules")), false);
});

test("создаёт симлинк каталога на источник внутри sourceDir", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  fs.mkdirSync(path.join(source, "shared"));
  fs.writeFileSync(path.join(source, "shared", "data.txt"), "shared-data");

  await prepareEnvironment(source, target, {
    sync: { copyFiles: [], symlinkDirs: ["shared"], exclude: [] },
  });

  const link = path.join(target, "shared");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(link, "data.txt"), "utf8"), "shared-data");
});

test("отклоняет абсолютные пути, .. и .git", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  fs.writeFileSync(path.join(source, "keep.txt"), "keep");

  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["../secret"], exclude: [] },
    }),
    expectCode("invalid_sync_path"),
  );
  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["/etc/passwd"], exclude: [] },
    }),
    expectCode("invalid_sync_path"),
  );
  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["./keep.txt"], exclude: [] },
    }),
    expectCode("invalid_sync_path"),
  );
  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: [".git/config"], exclude: [] },
    }),
    expectCode("invalid_sync_path"),
  );
});

test("не копирует через родительский симлинк наружу", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, path.join(source, "link"), "dir");

  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["link/secret.txt"], exclude: [] },
    }),
    expectCode("path_escape"),
  );
});

test("отклоняет вложенные симлинки при копировании", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(source, "dir"));
  fs.writeFileSync(path.join(source, "dir", "file.txt"), "file");
  fs.symlinkSync(outside, path.join(source, "dir", "nested"), "dir");

  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["dir"], exclude: [] },
    }),
    expectCode("symlink_not_allowed"),
  );
});

test("отклоняет вложенный .git при копировании каталога", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  fs.mkdirSync(path.join(source, "cache", ".git"), { recursive: true });
  fs.writeFileSync(path.join(source, "cache", ".git", "config"), "[core]");
  fs.writeFileSync(path.join(source, "cache", "data.txt"), "data");

  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["cache"], exclude: [] },
    }),
    expectCode("invalid_sync_path"),
  );
  assert.equal(fs.existsSync(path.join(target, "cache", ".git")), false);
});

test("отклоняет .git и .GIT независимо от регистра", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  fs.mkdirSync(path.join(source, "cache"));
  fs.writeFileSync(path.join(source, "cache", ".GIT"), "gitdir");
  fs.writeFileSync(path.join(source, ".GIT"), "toplevel");

  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["cache"], exclude: [] },
    }),
    expectCode("invalid_sync_path"),
  );
  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: [".GIT"], exclude: [] },
    }),
    expectCode("invalid_sync_path"),
  );
});

test("не перезаписывает существующие файлы и каталоги", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  fs.writeFileSync(path.join(source, "keep.txt"), "new");
  fs.writeFileSync(path.join(target, "keep.txt"), "old");

  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["keep.txt"], exclude: [] },
    }),
    expectCode("target_exists"),
  );
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "old");

  fs.mkdirSync(path.join(source, "sub"));
  fs.writeFileSync(path.join(source, "sub", "inner.txt"), "new");
  fs.mkdirSync(path.join(target, "sub"));
  fs.writeFileSync(path.join(target, "sub", "inner.txt"), "old");

  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["sub"], exclude: [] },
    }),
    expectCode("target_exists"),
  );
  assert.equal(fs.readFileSync(path.join(target, "sub", "inner.txt"), "utf8"), "old");
});

test("явно указывает на отсутствующий источник", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);

  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: ["missing.txt"], exclude: [] },
    }),
    expectCode("source_missing"),
  );
  await assert.rejects(
    prepareEnvironment(source, target, {
      sync: { copyFiles: [], symlinkDirs: ["missing"], exclude: [] },
    }),
    expectCode("source_missing"),
  );
});

test("ошибка хука прерывает выполнение и не запускает следующие", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "marker.txt");

  await assert.rejects(
    runHooks(
      [
        [process.execPath, "-e", "process.exit(3)"],
        [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done")`,
        ],
      ],
      root,
      {},
    ),
    expectCode("command_failed"),
  );

  assert.equal(fs.existsSync(marker), false);
});

test("argv- и shell-команды с пробелами получают env", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "with space");
  fs.mkdirSync(cwd);
  const argvOut = path.join(root, "argv out.txt");
  const shellOut = path.join(root, "shell out.txt");

  await runHooks(
    [
      [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.env.ARGV_OUT, process.env.BRANCH)",
      ],
      `"${process.execPath}" -e 'require("node:fs").writeFileSync(process.env.SHELL_OUT, "shell ok")'`,
    ],
    cwd,
    { ARGV_OUT: argvOut, SHELL_OUT: shellOut, BRANCH: "feat/x" },
  );

  assert.equal(fs.readFileSync(argvOut, "utf8"), "feat/x");
  assert.equal(fs.readFileSync(shellOut, "utf8"), "shell ok");
});

test("prepareEnvironment выполняет setup и postCreate с переданным env", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { source, target } = createSourceTarget(root);
  const setupOut = path.join(root, "setup.txt");
  const hookOut = path.join(root, "hook.txt");

  await prepareEnvironment(
    source,
    target,
    {
      sync: { copyFiles: [], symlinkDirs: [], exclude: [] },
      setup: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.env.SETUP_OUT, 'setup')",
      ],
      hooks: {
        postCreate: [
          `"${process.execPath}" -e 'require("node:fs").writeFileSync(process.env.HOOK_OUT, "hook")'`,
        ],
        preRemove: [],
      },
    },
    { env: { SETUP_OUT: setupOut, HOOK_OUT: hookOut, BRANCH: "b" } },
  );

  assert.equal(fs.readFileSync(setupOut, "utf8"), "setup");
  assert.equal(fs.readFileSync(hookOut, "utf8"), "hook");
});
