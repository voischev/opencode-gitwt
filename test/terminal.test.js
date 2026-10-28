import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitwtError } from "../src/process.js";
import {
  buildLaunchArgv,
  buildTerminalCommand,
  detectBackend,
  openTerminal,
  resolveOcxContext,
  shellQuote,
} from "../src/terminal.js";

function expectCode(code) {
  return (error) => error instanceof GitwtError && error.code === code;
}

function createRunner(result = { stdout: "", stderr: "", code: 0 }) {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    return result;
  };
  runner.calls = calls;
  return runner;
}

function createSpawnDetached(result = { ok: true }) {
  const calls = [];
  const spawnDetached = async (file, args, options) => {
    calls.push({ file, args, options });
    return result;
  };
  spawnDetached.calls = calls;
  return spawnDetached;
}

function createExecutable(t) {
  const base = path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "gitwt-ocx-"));
  const bin = path.join(dir, "ocx");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  fs.chmodSync(bin, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return bin;
}

test("buildLaunchArgv добавляет --session к команде по умолчанию", () => {
  assert.deepEqual(buildLaunchArgv({ sessionId: "ses_1" }), ["opencode", "--session", "ses_1"]);
  assert.deepEqual(buildLaunchArgv({}), ["opencode"]);
  assert.deepEqual(
    buildLaunchArgv({ config: { launchCommand: ["/usr/bin/env", "opencode"] }, sessionId: "x" }),
    ["/usr/bin/env", "opencode", "--session", "x"],
  );
});

test("buildLaunchArgv разворачивает OCX через OCX_BIN", () => {
  const argv = buildLaunchArgv({
    sessionId: "ses_1",
    ocx: { OCX_BIN: "/opt/ocx", OCX_PROFILE: "work" },
  });
  assert.deepEqual(argv, ["/opt/ocx", "opencode", "-p", "work", "--session", "ses_1"]);
});

test("resolveOcxContext требует полный контекст и исполняемый OCX_BIN", (t) => {
  const bin = createExecutable(t);
  assert.deepEqual(resolveOcxContext({}), {});
  assert.deepEqual(resolveOcxContext({ OCX_CONTEXT: "1", OCX_BIN: bin, OCX_PROFILE: "p" }), {
    OCX_CONTEXT: "1",
    OCX_BIN: bin,
    OCX_PROFILE: "p",
  });
  assert.throws(() => resolveOcxContext({ OCX_BIN: "/b" }), expectCode("invalid_ocx_context"));
  assert.throws(
    () => resolveOcxContext({ OCX_CONTEXT: "0", OCX_BIN: bin, OCX_PROFILE: "p" }),
    expectCode("invalid_ocx_context"),
  );
  assert.throws(
    () =>
      resolveOcxContext({
        OCX_CONTEXT: "1",
        OCX_BIN: path.join(os.tmpdir(), "нет-такого"),
        OCX_PROFILE: "p",
      }),
    expectCode("invalid_ocx_context"),
  );
});

test("корректно экранирует shell-строки и AppleScript", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote(""), "''");

  const xterm = buildTerminalCommand("xterm", {
    cwd: "/tmp/a b",
    argv: ["opencode", "--session", "x'y"],
    env: {},
    platform: "linux",
  });
  assert.equal(xterm.file, "xterm");
  assert.deepEqual(xterm.args.slice(0, 3), ["-e", "sh", "-c"]);
  assert.equal(xterm.args[3], "cd '/tmp/a b' && exec 'opencode' '--session' 'x'\\''y'");

  const terminal = buildTerminalCommand("terminal", {
    cwd: '/tmp/a"b',
    argv: ["opencode"],
    env: {},
    platform: "darwin",
  });
  assert.equal(terminal.file, "osascript");
  assert.equal(terminal.args[0], "-e");
  assert.ok(terminal.args[1].startsWith('tell application "Terminal"'));
  assert.ok(terminal.args[1].includes('/tmp/a\\"b'));
});

test("прямые GUI backend-ы помечены detached, tmux/osascript — нет", () => {
  const wezterm = buildTerminalCommand("wezterm", {
    cwd: "/tmp/a b",
    argv: ["opencode", "--session", "ses_1"],
    env: {},
    platform: "darwin",
  });
  assert.equal(wezterm.file, "wezterm");
  assert.deepEqual(wezterm.args, [
    "start",
    "--cwd",
    "/tmp/a b",
    "--",
    "opencode",
    "--session",
    "ses_1",
  ]);
  assert.equal(wezterm.detached, true);

  const tmux = buildTerminalCommand("tmux", {
    cwd: "/work",
    argv: ["opencode", "--session", "ses_1"],
    name: "feat/x",
    env: {},
    platform: "linux",
  });
  assert.deepEqual(tmux.args.slice(0, 5), ["new-window", "-c", "/work", "-n", "feat/x"]);
  assert.equal(tmux.args[5], "cd '/work' && exec 'opencode' '--session' 'ses_1'");
  assert.notEqual(tmux.detached, true);
});

test("mac ghostty открывается через open -na", () => {
  const ghostty = buildTerminalCommand("ghostty", {
    cwd: "/work",
    argv: ["opencode", "--session", "ses_1"],
    env: {},
    platform: "darwin",
  });
  assert.equal(ghostty.file, "open");
  assert.deepEqual(ghostty.args, [
    "-na",
    "Ghostty",
    "--args",
    "--working-directory=/work",
    "-e",
    "opencode",
    "--session",
    "ses_1",
  ]);
});

test("cmux вызывает new-workspace без неподтверждённых флагов", () => {
  const { file, args } = buildTerminalCommand("cmux", {
    cwd: "/work",
    argv: ["opencode", "--session", "ses_1"],
    name: "feat/x",
    env: {},
    platform: "darwin",
  });
  assert.equal(file, "cmux");
  assert.deepEqual(args.slice(0, 3), ["new-workspace", "--cwd", "/work"]);
  assert.equal(args[3], "--command");
  assert.equal(args[4], "cd '/work' && exec 'opencode' '--session' 'ses_1'");
  assert.equal(args.includes("--name"), false);
});

test("detectBackend выбирает cmux только по реальным маркерам", () => {
  const hasCommand = (name) => name === "cmux";
  assert.equal(
    detectBackend({
      env: { CMUX_WORKSPACE_ID: "w" },
      platform: "darwin",
      hasCommand,
      hasApp: () => false,
    }),
    "cmux",
  );
  assert.equal(
    detectBackend({
      env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock", CMUX_SOCKET_MODE: "allowAll" },
      platform: "darwin",
      hasCommand,
      hasApp: () => false,
    }),
    "cmux",
  );
  assert.equal(
    detectBackend({ env: {}, platform: "darwin", hasCommand, hasApp: () => false }),
    null,
  );
  assert.equal(
    detectBackend({
      env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
      platform: "darwin",
      hasCommand,
      hasApp: () => false,
    }),
    null,
  );
});

test("warp не возвращает success, а предлагает ручной запуск", async () => {
  const runner = createRunner();
  const result = await openTerminal({
    cwd: "/work",
    sessionId: "ses_1",
    config: { terminal: "warp" },
    env: {},
    runner,
    platform: "darwin",
    hasCommand: () => false,
    hasApp: (app) => app === "/Applications/Warp.app",
  });

  assert.equal(result.success, false);
  assert.equal(result.terminal, "warp");
  assert.match(result.error, /вручную/);
  assert.match(result.error, /'--session' 'ses_1'/);
  assert.equal(runner.calls.length, 0);
});

test("detectBackend не выбирает warp автоматически", () => {
  assert.equal(
    detectBackend({
      env: { TERM_PROGRAM: "WarpTerminal" },
      platform: "darwin",
      hasCommand: () => false,
      hasApp: (app) => app === "/Applications/Warp.app",
    }),
    null,
  );
});

test("detectBackend отдаёт приоритет tmux, затем окружению", () => {
  assert.equal(
    detectBackend({
      env: { TMUX: "/tmp/tmux" },
      platform: "linux",
      hasCommand: (name) => name === "tmux",
      hasApp: () => false,
    }),
    "tmux",
  );
  assert.equal(
    detectBackend({
      config: { terminal: "kitty" },
      env: {},
      platform: "linux",
      hasCommand: () => false,
      hasApp: () => false,
    }),
    "kitty",
  );
  assert.equal(
    detectBackend({
      env: { TERM_PROGRAM: "iTerm.app" },
      platform: "darwin",
      hasCommand: () => false,
      hasApp: (app) => app === "/Applications/iTerm.app",
    }),
    "iterm",
  );
});

test("openTerminal запускает tmux через await runner", async () => {
  const runner = createRunner();
  const result = await openTerminal({
    cwd: "/work",
    sessionId: "ses_1",
    branch: "feat/x",
    config: { terminal: "tmux" },
    env: { TMUX: "/tmp/tmux-1" },
    runner,
    platform: "darwin",
    hasCommand: (name) => name === "tmux",
    hasApp: () => false,
  });

  assert.equal(result.success, true);
  assert.equal(result.terminal, "tmux");
  assert.deepEqual(result.argv, ["opencode", "--session", "ses_1"]);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].file, "tmux");
  assert.equal(runner.calls[0].options.cwd, "/work");
});

test("openTerminal для GUI backend делает detached spawn, а не await", async (t) => {
  const bin = createExecutable(t);
  const runner = createRunner();
  const spawnDetached = createSpawnDetached();

  const result = await openTerminal({
    cwd: "/work",
    sessionId: "ses_1",
    config: { terminal: "kitty" },
    env: { OCX_CONTEXT: "1", OCX_BIN: bin, OCX_PROFILE: "work" },
    runner,
    spawnDetached,
    platform: "darwin",
    hasCommand: (name) => name === "kitty",
    hasApp: () => false,
  });

  assert.equal(result.success, true);
  assert.equal(result.terminal, "kitty");
  assert.deepEqual(result.argv, [bin, "opencode", "-p", "work", "--session", "ses_1"]);
  assert.equal(runner.calls.length, 0);
  assert.equal(spawnDetached.calls.length, 1);
  assert.equal(spawnDetached.calls[0].file, "kitty");
  assert.deepEqual(spawnDetached.calls[0].args, [
    "--directory",
    "/work",
    bin,
    "opencode",
    "-p",
    "work",
    "--session",
    "ses_1",
  ]);
});

test("openTerminal возвращает ошибку, если detached spawn упал", async () => {
  const spawnDetached = createSpawnDetached({ ok: false, error: "ENOENT" });
  const result = await openTerminal({
    cwd: "/work",
    sessionId: "ses_1",
    config: { terminal: "kitty" },
    env: {},
    runner: createRunner(),
    spawnDetached,
    platform: "linux",
    hasCommand: (name) => name === "kitty",
    hasApp: () => false,
  });

  assert.equal(result.success, false);
  assert.equal(result.terminal, "kitty");
  assert.equal(result.error, "ENOENT");
});

test("openTerminal возвращает ошибку запуска короткого backend без удаления worktree", async () => {
  const runner = createRunner({ stdout: "", stderr: "boom", code: 2 });
  const result = await openTerminal({
    cwd: "/work",
    sessionId: "ses_1",
    config: { terminal: "tmux" },
    env: {},
    runner,
    platform: "darwin",
    hasCommand: (name) => name === "tmux",
    hasApp: () => false,
  });

  assert.equal(result.success, false);
  assert.equal(result.terminal, "tmux");
  assert.equal(result.error, "boom");
  assert.equal(runner.calls.length, 1);
});

test("config.terminal=none не запускает терминал", async () => {
  const runner = createRunner();
  const spawnDetached = createSpawnDetached();
  const result = await openTerminal({
    cwd: "/work",
    sessionId: "ses_1",
    config: { terminal: "none" },
    env: {},
    runner,
    spawnDetached,
    platform: "darwin",
    hasCommand: () => false,
    hasApp: () => false,
  });

  assert.equal(result.success, true);
  assert.equal(result.terminal, "none");
  assert.equal(runner.calls.length, 0);
  assert.equal(spawnDetached.calls.length, 0);
});

test("openTerminal отвергает неполный OCX и недоступный терминал", async (t) => {
  await assert.rejects(
    openTerminal({
      cwd: "/work",
      config: { terminal: "none" },
      env: { OCX_PROFILE: "p" },
      runner: createRunner(),
      platform: "darwin",
    }),
    expectCode("invalid_ocx_context"),
  );

  const bin = createExecutable(t);
  await assert.rejects(
    openTerminal({
      cwd: "/work",
      config: { terminal: "none" },
      env: { OCX_CONTEXT: "1", OCX_BIN: bin, OCX_PROFILE: "" },
      runner: createRunner(),
      platform: "darwin",
    }),
    expectCode("invalid_ocx_context"),
  );

  const result = await openTerminal({
    cwd: "/work",
    config: { terminal: "kitty" },
    env: {},
    runner: createRunner(),
    platform: "linux",
    hasCommand: () => false,
    hasApp: () => false,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /недоступен/);
});
