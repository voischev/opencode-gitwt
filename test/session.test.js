import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { GitwtError } from "../src/process.js";
import { forkSession, resolveDataDirectory } from "../src/session.js";

const TEMP_BASE = process.env.GITWT_TEST_TMP ?? path.join(os.tmpdir(), "opencode");
const MOVE_PATH = "/experimental/control-plane/move-session";

function createRoot() {
  fs.mkdirSync(TEMP_BASE, { recursive: true });
  return fs.realpathSync(fs.mkdtempSync(path.join(TEMP_BASE, "gitwt-session-")));
}

function expectCode(code) {
  return (error) => error instanceof GitwtError && error.code === code;
}

function createMoveClient(initial, { move = "ok" } = {}) {
  const state = structuredClone(initial);
  const calls = { get: [], fork: [], delete: [], move: [] };
  return {
    calls,
    state,
    session: {
      async get({ path: { id } }) {
        calls.get.push(id);
        return state[id] ? { data: state[id] } : { error: { message: `not found: ${id}` } };
      },
      async fork({ path: { id }, query }) {
        calls.fork.push({ id, query });
        const origin = state[id];
        if (!origin) return { error: { message: `not found: ${id}` } };
        const forked = { id: "ses_new", directory: origin.directory, projectID: origin.projectID };
        state.ses_new = forked;
        return { data: forked };
      },
      async delete({ path: { id } }) {
        calls.delete.push(id);
        delete state[id];
        return { data: true };
      },
    },
    _client: {
      async post({ url, body }) {
        calls.move.push({ url, body });
        if (move === "error") {
          return {
            error: { name: "MoveSessionError", data: { message: "boom" } },
            response: { status: 400 },
          };
        }
        if (move === "noop") {
          return { data: {}, response: { status: 204 } };
        }
        const target = state[body.sessionID];
        if (target) target.directory = body.destination.directory;
        return { data: {}, response: { status: 204 } };
      },
    },
  };
}

test("находит корень по цепочке parentID через forkSession", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = createMoveClient({
    ses_a: { id: "ses_a", parentID: "ses_b", directory: root, projectID: "proj" },
    ses_b: { id: "ses_b", parentID: "ses_c", directory: root, projectID: "proj" },
    ses_c: { id: "ses_c", directory: root, projectID: "proj" },
  });

  const result = await forkSession({
    client,
    sessionId: "ses_a",
    projectId: "proj",
    sourceDirectory: root,
    targetDirectory: path.join(root, "target"),
    dataDirectory: path.join(root, "data"),
  });

  assert.equal(result.rootSessionId, "ses_c");
  assert.deepEqual(client.calls.get.slice(0, 3), ["ses_a", "ses_b", "ses_c"]);
});

test("детектит цикл parentID", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = createMoveClient({
    x: { id: "x", parentID: "y", directory: root, projectID: "proj" },
    y: { id: "y", parentID: "x", directory: root, projectID: "proj" },
  });

  await assert.rejects(
    forkSession({
      client,
      sessionId: "x",
      projectId: "proj",
      sourceDirectory: root,
      targetDirectory: path.join(root, "target"),
      dataDirectory: path.join(root, "data"),
    }),
    expectCode("session_cycle"),
  );
  assert.deepEqual(client.calls.fork, []);
});

test("ограничивает глубину цепочки parentID", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = {};
  for (let index = 0; index < 12; index += 1) {
    sessions[`n${index}`] = {
      id: `n${index}`,
      directory: root,
      projectID: "proj",
      ...(index < 11 ? { parentID: `n${index + 1}` } : {}),
    };
  }
  const client = createMoveClient(sessions);

  await assert.rejects(
    forkSession({
      client,
      sessionId: "n0",
      projectId: "proj",
      sourceDirectory: root,
      targetDirectory: path.join(root, "target"),
      dataDirectory: path.join(root, "data"),
    }),
    expectCode("session_parent_depth"),
  );
});

test("mode=move: форкает и переносит сессию в targetDirectory", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const client = createMoveClient({ ses: { id: "ses", directory: source, projectID: "proj" } });

  const result = await forkSession({
    client,
    sessionId: "ses",
    projectId: "proj",
    sourceDirectory: source,
    targetDirectory: target,
    dataDirectory: path.join(root, "data"),
  });

  assert.deepEqual(result, {
    sessionId: "ses_new",
    rootSessionId: "ses",
    contextCopied: false,
    mode: "move",
  });
  assert.equal(client.state.ses_new.directory, target);
  assert.equal(client.calls.move.length, 1);
  assert.equal(client.calls.move[0].url, MOVE_PATH);
  assert.equal(client.calls.move[0].body.moveChanges, false);
  assert.equal(client.calls.move[0].body.destination.directory, target);
  assert.deepEqual(client.calls.delete, []);
});

test("mode=move: переносит plan.md и delegations в новую сессию", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(path.join(dataRoot, "workspace", "proj", "root"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "delegations", "proj", "root"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "workspace", "proj", "root", "plan.md"), "план");
  fs.writeFileSync(path.join(dataRoot, "delegations", "proj", "root", "task.json"), "{}");
  const client = createMoveClient({
    ses: { id: "ses", parentID: "root", directory: source, projectID: "proj" },
    root: { id: "root", directory: source, projectID: "proj" },
  });

  const result = await forkSession({
    client,
    sessionId: "ses",
    projectId: "proj",
    sourceDirectory: source,
    targetDirectory: target,
    dataDirectory: dataRoot,
  });

  assert.equal(result.rootSessionId, "root");
  assert.equal(result.contextCopied, true);
  assert.equal(
    fs.readFileSync(path.join(dataRoot, "workspace", "proj", "ses_new", "plan.md"), "utf8"),
    "план",
  );
  assert.equal(
    fs.readFileSync(path.join(dataRoot, "delegations", "proj", "ses_new", "task.json"), "utf8"),
    "{}",
  );
});

test("mode=move: при ошибке переноса откатывает только форк", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const client = createMoveClient(
    { ses: { id: "ses", directory: source, projectID: "proj" } },
    { move: "error" },
  );

  await assert.rejects(
    forkSession({
      client,
      sessionId: "ses",
      projectId: "proj",
      sourceDirectory: source,
      targetDirectory: target,
      dataDirectory: path.join(root, "data"),
    }),
    expectCode("session_move_failed"),
  );
  assert.deepEqual(client.calls.delete, ["ses_new"]);
  assert.equal(fs.existsSync(path.join(root, "data", "workspace")), false);
});

test("mode=move: не принимает 204 без смены каталога", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const client = createMoveClient(
    { ses: { id: "ses", directory: source, projectID: "proj" } },
    { move: "noop" },
  );

  await assert.rejects(
    forkSession({
      client,
      sessionId: "ses",
      projectId: "proj",
      sourceDirectory: source,
      targetDirectory: target,
      dataDirectory: path.join(root, "data"),
    }),
    expectCode("session_verify_failed"),
  );
  assert.deepEqual(client.calls.delete, ["ses_new"]);
});

test("без _client transport отдаёт честную ошибку и не форкает", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { fork: [] };
  const client = {
    session: {
      async get() {
        return { data: { id: "ses", directory: root, projectID: "proj" } };
      },
      async fork() {
        calls.fork.push(true);
        return { data: { id: "ses_new", directory: root } };
      },
    },
  };

  await assert.rejects(
    forkSession({
      client,
      sessionId: "ses",
      projectId: "proj",
      sourceDirectory: root,
      targetDirectory: path.join(root, "target"),
      dataDirectory: path.join(root, "data"),
    }),
    expectCode("session_move_unavailable"),
  );
  assert.deepEqual(calls.fork, []);
});

test("mode=move: ошибка копирования контекста откатывает сессию и каталоги", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(path.join(dataRoot, "workspace", "proj", "root"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "delegations", "proj", "root"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "workspace", "proj", "root", "plan.md"), "план");
  fs.writeFileSync(path.join(dataRoot, "delegations", "proj", "root", "task.json"), "{}");
  fs.writeFileSync(path.join(dataRoot, "delegations", "proj", "ses_new"), "занято");
  const client = createMoveClient({
    ses: { id: "ses", parentID: "root", directory: source, projectID: "proj" },
    root: { id: "root", directory: source, projectID: "proj" },
  });

  await assert.rejects(
    forkSession({
      client,
      sessionId: "ses",
      projectId: "proj",
      sourceDirectory: source,
      targetDirectory: target,
      dataDirectory: dataRoot,
    }),
    expectCode("context_target_exists"),
  );
  assert.deepEqual(client.calls.delete, ["ses_new"]);
  assert.equal(fs.existsSync(path.join(dataRoot, "workspace", "proj", "ses_new")), false);
});

test("откат сообщает об ошибке удаления, не скрывая исходную", async (t) => {
  const root = createRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const client = createMoveClient(
    { ses: { id: "ses", directory: source, projectID: "proj" } },
    { move: "error" },
  );
  client.session.delete = async () => ({ error: { message: "delete упал" } });

  await assert.rejects(
    forkSession({
      client,
      sessionId: "ses",
      projectId: "proj",
      sourceDirectory: source,
      targetDirectory: path.join(root, "target"),
      dataDirectory: path.join(root, "data"),
    }),
    (error) => {
      assert.equal(error.code, "session_move_failed");
      assert.match(error.details.rollbackError, /delete упал/);
      return true;
    },
  );
});

test("resolveDataDirectory уважает XDG_DATA_HOME и параметр", () => {
  assert.equal(resolveDataDirectory("/tmp/iso"), path.resolve("/tmp/iso"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = "/tmp/xdg";
  try {
    assert.equal(resolveDataDirectory(), path.join("/tmp/xdg", "opencode"));
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
  assert.throws(() => resolveDataDirectory(""), expectCode("invalid_data_directory"));
});

function opencodeVersion() {
  try {
    return execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function hasGit() {
  try {
    execFileSync("git", ["--version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function git(args, cwd) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Тест",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Тест",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function isolatedEnv(root) {
  const home = path.join(root, "home");
  const npmrc = path.join(root, "npmrc");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(npmrc, "");
  return {
    ...process.env,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    NPM_CONFIG_USERCONFIG: npmrc,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [
        [
          process.env.GITWT_TEST_PLUGIN_SPEC ?? pathToFileURL(path.resolve("src/index.js")).href,
          { terminal: "none", forkSession: true },
        ],
      ],
    }),
  };
}

function startServer(env, cwd, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "opencode",
      ["serve", "--print-logs", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("сервер не запустился")), 20000);
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-16000);
      const match = output.match(/listening on (http:\/\/\S+)/);
      if (match) finish(null, match[1]);
    };
    function finish(error, url) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGTERM");
        reject(error);
      } else resolve({ child, url, output: () => output });
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", finish);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
  });
}

function createHttpClient(baseUrl) {
  const request = async (method, pathname, { query, body } = {}) => {
    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null) url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) return { error: parsed, response };
    return { data: parsed, response };
  };
  return {
    session: {
      get: ({ path: { id }, query }) => request("GET", `/session/${id}`, { query }),
      create: ({ query, body }) => request("POST", "/session", { query, body }),
      fork: ({ path: { id }, query, body }) =>
        request("POST", `/session/${id}/fork`, { query, body }),
      delete: ({ path: { id }, query }) => request("DELETE", `/session/${id}`, { query }),
      messages: ({ path: { id }, query }) => request("GET", `/session/${id}/message`, { query }),
      prompt: ({ path: { id }, query, body }) =>
        request("POST", `/session/${id}/message`, { query, body }),
    },
    _client: {
      post: ({ url, body }) => request("POST", url, { body }),
    },
  };
}

test("изоляция: реальный opencode serve переносит сессию в git worktree", {
  timeout: 90000,
}, async (t) => {
  const version = opencodeVersion();
  if (!version) {
    t.skip("opencode CLI не найден");
    return;
  }
  if (version !== "1.19.3") {
    t.skip(`opencode ${version} не поддерживается тестом (нужен 1.19.3)`);
    return;
  }
  if (!hasGit()) {
    t.skip("git не найден");
    return;
  }

  const root = createRoot();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
  git(["add", "a.txt"], repo);
  git(["commit", "-qm", "init"], repo);
  const worktree = path.join(root, "wt");
  git(["worktree", "add", "-q", worktree, "-b", "wt"], repo);

  const port = await freePort();
  const server = await startServer(isolatedEnv(root), repo, port);
  t.after(async () => {
    await stopServer(server.child);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const client = createHttpClient(server.url);
  const source = fs.realpathSync(repo);
  const target = fs.realpathSync(worktree);
  const eventsAbort = new AbortController();
  const events = await fetch(`${server.url}/global/event`, { signal: eventsAbort.signal });
  let eventOutput = "";
  const observe = async () => {
    try {
      for await (const chunk of events.body) {
        eventOutput = (eventOutput + new TextDecoder().decode(chunk)).slice(-16000);
      }
    } catch {}
  };
  observe();
  t.after(() => eventsAbort.abort());

  const tools = await fetch(
    `${server.url}/experimental/tool/ids?directory=${encodeURIComponent(source)}`,
  ).then((response) => response.json());
  for (const name of ["gitwt_create", "gitwt_list", "gitwt_remove"]) {
    assert.ok(
      tools.includes(name),
      `Инструмент ${name} не зарегистрирован: ${JSON.stringify(tools)}\n${server.output()}\n${eventOutput}`,
    );
  }

  const created = await client.session.create({ query: { directory: source }, body: {} });
  assert.equal(created.error, undefined);
  await client.session.prompt({
    path: { id: created.data.id },
    query: { directory: source },
    body: {
      noReply: true,
      model: { providerID: "test", modelID: "test" },
      parts: [{ type: "text", text: "привет из источника" }],
    },
  });

  const result = await forkSession({
    client,
    sessionId: created.data.id,
    projectId: created.data.projectID,
    sourceDirectory: source,
    targetDirectory: target,
    dataDirectory: path.join(root, "data", "opencode"),
  });

  assert.equal(result.mode, "move");
  const moved = await client.session.get({ path: { id: result.sessionId } });
  assert.equal(moved.error, undefined);
  assert.equal(moved.data.directory, target);
  assert.equal(moved.data.projectID, created.data.projectID);

  const messages = await client.session.messages({ path: { id: result.sessionId } });
  assert.ok(
    messages.data.some((message) =>
      message.parts.some(
        (part) => part.type === "text" && part.text.includes("привет из источника"),
      ),
    ),
    "сообщения не сохранились при переносе",
  );
});
