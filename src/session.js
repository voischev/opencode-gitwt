import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GitwtError } from "./process.js";

const MAX_PARENT_DEPTH = 10;
const MOVE_SESSION_PATH = "/experimental/control-plane/move-session";

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorText(error) {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error.data && typeof error.data.message === "string") return error.data.message;
  if (typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function assertSegment(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitwtError("invalid_session_argument", `Поле ${field} должно быть непустой строкой`, {
      field,
    });
  }
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new GitwtError("invalid_session_argument", `Недопустимое значение ${field}: ${value}`, {
      field,
      value,
    });
  }
  return value;
}

function assertDirectory(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitwtError("invalid_session_argument", `Поле ${field} должно быть непустой строкой`, {
      field,
    });
  }
  return value;
}

function assertClient(client) {
  if (!client || typeof client.session !== "object" || client.session === null) {
    throw new GitwtError("invalid_client", "Требуется клиент OpenCode SDK с объектом session", {});
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new GitwtError("aborted", "Операция отменена", {});
  }
}

export function resolveDataDirectory(dataDirectory) {
  if (dataDirectory != null) {
    if (typeof dataDirectory !== "string" || dataDirectory.length === 0) {
      throw new GitwtError("invalid_data_directory", "dataDirectory должен быть непустой строкой", {
        dataDirectory,
      });
    }
    return path.resolve(dataDirectory);
  }
  const base = process.env.XDG_DATA_HOME;
  if (typeof base === "string" && base.length > 0) {
    return path.join(base, "opencode");
  }
  return path.join(os.homedir(), ".local", "share", "opencode");
}

async function callSession(fn, request, { code, message, details = {} }) {
  let result;
  try {
    result = await fn(request);
  } catch (error) {
    throw new GitwtError(code, `${message}: ${errorMessage(error)}`, { ...details, cause: error });
  }
  if (result && typeof result === "object" && result.error) {
    throw new GitwtError(code, `${message}: ${errorText(result.error)}`, {
      ...details,
      error: result.error,
    });
  }
  return result?.data;
}

async function getSession(client, sessionId, directory, signal) {
  return callSession(
    (request) => client.session.get(request),
    { path: { id: sessionId }, ...(directory ? { query: { directory } } : {}), signal },
    {
      code: "session_get_failed",
      message: `Не удалось получить сессию ${sessionId}`,
      details: { sessionId },
    },
  );
}

async function findRootSession(client, sessionId, directory, signal) {
  const seen = new Set();
  let current = sessionId;
  let hop = 0;
  for (;;) {
    throwIfAborted(signal);
    if (seen.has(current)) {
      throw new GitwtError(
        "session_cycle",
        `Обнаружен цикл в цепочке parentID сессии ${sessionId}`,
        {
          sessionId,
        },
      );
    }
    seen.add(current);
    const info = await getSession(client, current, directory, signal);
    if (!info) {
      throw new GitwtError("session_get_failed", `Сессия ${current} не найдена`, {
        sessionId: current,
      });
    }
    if (!info.parentID) {
      return info.id ?? current;
    }
    if (hop >= MAX_PARENT_DEPTH) {
      throw new GitwtError("session_parent_depth", `Цепочка parentID длиннее ${MAX_PARENT_DEPTH}`, {
        sessionId,
      });
    }
    current = info.parentID;
    hop += 1;
  }
}

function resolveCoreTransport(client) {
  const core = client?._client;
  if (core && typeof core.post === "function") return core;
  return null;
}

async function createFork(client, sessionId, directory, signal) {
  const info = await callSession(
    (request) => client.session.fork(request),
    {
      path: { id: sessionId },
      ...(directory ? { query: { directory } } : {}),
      body: {},
      signal,
    },
    {
      code: "session_fork_failed",
      message: `Не удалось форкнуть сессию ${sessionId}`,
      details: { sessionId },
    },
  );
  if (!info?.id) {
    throw new GitwtError("session_fork_failed", "Сервер не вернул идентификатор новой сессии", {
      sessionId,
    });
  }
  return info;
}

async function moveSessionTo(transport, sessionId, directory, signal) {
  let result;
  try {
    result = await transport.post({
      url: MOVE_SESSION_PATH,
      body: { sessionID: sessionId, destination: { directory }, moveChanges: false },
      headers: { "Content-Type": "application/json" },
      signal,
    });
  } catch (error) {
    throw new GitwtError(
      "session_move_failed",
      `Не удалось перенести сессию ${sessionId}: ${errorText(error)}`,
      {
        sessionId,
        target: directory,
        cause: error,
      },
    );
  }
  if (result && typeof result === "object" && result.error) {
    throw new GitwtError(
      "session_move_failed",
      `Перенос сессии отклонён: ${errorText(result.error)}`,
      {
        sessionId,
        target: directory,
        status: result.response?.status,
        error: result.error,
      },
    );
  }
}

async function assertSessionDirectory(client, sessionId, directory, signal) {
  const info = await getSession(client, sessionId, directory, signal);
  if (!info) {
    throw new GitwtError("session_verify_failed", `Сессия ${sessionId} не найдена после переноса`, {
      sessionId,
    });
  }
  if (info.directory !== directory) {
    throw new GitwtError(
      "session_verify_failed",
      `Каталог сессии ${info.directory} не совпадает с целевым ${directory}`,
      { sessionId, expected: directory, actual: info.directory },
    );
  }
  return info;
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function ensureDirTracked(target, createdDirs) {
  const missing = [];
  let current = target;
  while (!exists(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fs.mkdirSync(target, { recursive: true });
  for (const dir of missing.reverse()) {
    if (!createdDirs.includes(dir)) createdDirs.push(dir);
  }
}

function copyContext({ dataRoot, projectId, rootSessionId, newSessionId, createdDirs }) {
  let copied = false;
  const entries = [
    { kind: "workspace", name: "plan.md" },
    { kind: "delegations", name: null },
  ];
  for (const { kind, name } of entries) {
    const sourceBase = path.join(dataRoot, kind, projectId, rootSessionId);
    const source = name ? path.join(sourceBase, name) : sourceBase;
    if (!exists(source)) continue;
    const targetBase = path.join(dataRoot, kind, projectId, newSessionId);
    const target = name ? path.join(targetBase, name) : targetBase;
    try {
      if (exists(target)) {
        throw new GitwtError(
          "context_target_exists",
          `В новой сессии уже существует ${name ?? kind}`,
          {
            kind,
            target,
          },
        );
      }
      ensureDirTracked(name ? targetBase : path.dirname(targetBase), createdDirs);
      if (!name) createdDirs.push(targetBase);
      fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    } catch (error) {
      if (error instanceof GitwtError) throw error;
      throw new GitwtError(
        "context_copy_failed",
        `Не удалось перенести ${name ?? kind}: ${error.message}`,
        {
          kind,
          source,
          target,
          cause: error,
        },
      );
    }
    copied = true;
  }
  return copied;
}

function removeCreatedDirs(createdDirs) {
  const dirs = [...createdDirs].sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    if (dirs.some((other) => other.startsWith(dir + path.sep))) {
      try {
        fs.rmdirSync(dir);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      }
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function rollbackFork({ client, sessionId, directory, createdDirs }) {
  let rollbackError;
  try {
    await callSession(
      (request) => client.session.delete(request),
      { path: { id: sessionId }, ...(directory ? { query: { directory } } : {}) },
      {
        code: "session_delete_failed",
        message: `Не удалось удалить сессию ${sessionId}`,
        details: { sessionId },
      },
    );
  } catch (error) {
    rollbackError = errorMessage(error);
  }
  removeCreatedDirs(createdDirs);
  return rollbackError;
}

async function failWithRollback(error, rollback) {
  const rollbackError = await rollback();
  if (rollbackError && error instanceof GitwtError) {
    error.details = { ...error.details, rollbackError };
  }
  throw error;
}

export async function forkSession({
  client,
  sessionId,
  projectId,
  sourceDirectory,
  targetDirectory,
  dataDirectory,
  signal,
} = {}) {
  assertClient(client);
  assertSegment(sessionId, "sessionId");
  assertSegment(projectId, "projectId");
  const source = assertDirectory(sourceDirectory, "sourceDirectory");
  const target = assertDirectory(targetDirectory, "targetDirectory");
  const dataRoot = resolveDataDirectory(dataDirectory);

  throwIfAborted(signal);
  const rootSessionId = await findRootSession(client, sessionId, source, signal);

  const transport = resolveCoreTransport(client);
  if (!transport) {
    throw new GitwtError(
      "session_move_unavailable",
      "Клиент OpenCode SDK не поддерживает перенос сессии",
      {
        sessionId,
      },
    );
  }

  throwIfAborted(signal);
  const forked = await createFork(client, sessionId, source, signal);
  const newSessionId = forked.id;

  try {
    await moveSessionTo(transport, newSessionId, target, signal);
    await assertSessionDirectory(client, newSessionId, target, signal);
  } catch (error) {
    await failWithRollback(error, () =>
      rollbackFork({ client, sessionId: newSessionId, directory: target, createdDirs: [] }),
    );
  }

  const createdDirs = [];
  try {
    const contextCopied = copyContext({
      dataRoot,
      projectId,
      rootSessionId,
      newSessionId,
      createdDirs,
    });
    return { sessionId: newSessionId, rootSessionId, contextCopied, mode: "move" };
  } catch (error) {
    await failWithRollback(error, () =>
      rollbackFork({ client, sessionId: newSessionId, directory: target, createdDirs }),
    );
  }
}
