import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { GitwtError, run } from "./process.js";

const OCX_KEYS = ["OCX_CONTEXT", "OCX_BIN", "OCX_PROFILE"];

const PLATFORM_PRIORITY = {
  darwin: ["iterm", "ghostty", "kitty", "wezterm", "alacritty", "terminal"],
  linux: ["kitty", "wezterm", "alacritty", "ghostty", "gnome-terminal", "konsole", "xterm"],
  win32: ["windows-terminal"],
};

const TERM_PROGRAM_BACKEND = {
  Apple_Terminal: "terminal",
  "iTerm.app": "iterm",
  ghostty: "ghostty",
  WarpTerminal: "warp",
  WezTerm: "wezterm",
  kitty: "kitty",
  alacritty: "alacritty",
};

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function resolveOcxContext(env = {}) {
  const present = OCX_KEYS.filter((key) => env[key] != null && env[key] !== "");
  if (present.length === 0) return {};
  const missing = OCX_KEYS.filter((key) => env[key] == null || env[key] === "");
  if (missing.length > 0) {
    throw new GitwtError(
      "invalid_ocx_context",
      `Неполный OCX-контекст: отсутствует ${missing.join(", ")}`,
      {
        missing,
      },
    );
  }
  if (String(env.OCX_CONTEXT) !== "1") {
    throw new GitwtError("invalid_ocx_context", "OCX_CONTEXT должен быть равен 1", {
      value: env.OCX_CONTEXT,
    });
  }
  const configured = String(env.OCX_BIN);
  const candidates =
    configured.includes("/") || configured.includes("\\")
      ? [path.resolve(configured)]
      : (env.PATH ?? process.env.PATH ?? "")
          .split(path.delimiter)
          .map((dir) => path.resolve(dir, configured));
  const bin = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  try {
    if (!bin) throw new Error("Исполняемый файл не найден");
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    throw new GitwtError("invalid_ocx_context", `OCX_BIN не является исполняемым файлом: ${bin}`, {
      bin: env.OCX_BIN,
    });
  }
  return { OCX_CONTEXT: "1", OCX_BIN: bin, OCX_PROFILE: String(env.OCX_PROFILE) };
}

export function shellQuote(value) {
  const str = String(value);
  if (str.length === 0) return "''";
  return `'${str.replace(/'/g, "'\\''")}'`;
}

function shellJoin(argv) {
  return argv.map(shellQuote).join(" ");
}

function ocxExportLine(env) {
  const parts = [];
  for (const key of OCX_KEYS) {
    if (env[key] != null && env[key] !== "") {
      parts.push(`${key}=${shellQuote(env[key])}`);
    }
  }
  if (parts.length === 0) return "";
  return `export ${parts.join(" ")}`;
}

function buildShellLine({ cwd, argv, env }) {
  const parts = [];
  const exports = ocxExportLine(env);
  if (exports) parts.push(exports);
  if (cwd) parts.push(`cd ${shellQuote(cwd)}`);
  parts.push(`exec ${shellJoin(argv)}`);
  return parts.join(" && ");
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const BACKENDS = {
  tmux: {
    platforms: ["darwin", "linux", "win32"],
    requiresTmux: true,
    binaries: ["tmux"],
    build(ctx) {
      return {
        file: "tmux",
        args: ["new-window", "-c", ctx.cwd, "-n", ctx.name, buildShellLine(ctx)],
      };
    },
  },
  cmux: {
    platforms: ["darwin"],
    binaries: ["cmux"],
    build(ctx) {
      return {
        file: "cmux",
        args: ["new-workspace", "--cwd", ctx.cwd, "--command", buildShellLine(ctx)],
      };
    },
  },
  terminal: {
    platforms: ["darwin"],
    apps: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"],
    build(ctx) {
      const script = `tell application "Terminal"
activate
do script "${escapeAppleScript(buildShellLine(ctx))}"
end tell`;
      return { file: "osascript", args: ["-e", script] };
    },
  },
  iterm: {
    platforms: ["darwin"],
    binaries: ["iterm2"],
    apps: ["/Applications/iTerm.app", "/Applications/iTerm2.app"],
    build(ctx) {
      const script = `tell application "iTerm"
activate
create window with default profile command "${escapeAppleScript(buildShellLine(ctx))}"
end tell`;
      return { file: "osascript", args: ["-e", script] };
    },
  },
  ghostty: {
    platforms: ["darwin", "linux"],
    binaries: ["ghostty"],
    apps: ["/Applications/Ghostty.app"],
    build(ctx) {
      if (ctx.platform === "darwin") {
        return {
          file: "open",
          args: ["-na", "Ghostty", "--args", `--working-directory=${ctx.cwd}`, "-e", ...ctx.argv],
        };
      }
      return {
        file: "ghostty",
        args: [`--working-directory=${ctx.cwd}`, "-e", ...ctx.argv],
        detached: true,
      };
    },
  },
  kitty: {
    platforms: ["darwin", "linux"],
    binaries: ["kitty"],
    build(ctx) {
      return { file: "kitty", args: ["--directory", ctx.cwd, ...ctx.argv], detached: true };
    },
  },
  wezterm: {
    platforms: ["darwin", "linux"],
    binaries: ["wezterm"],
    build(ctx) {
      return {
        file: "wezterm",
        args: ["start", "--cwd", ctx.cwd, "--", ...ctx.argv],
        detached: true,
      };
    },
  },
  alacritty: {
    platforms: ["darwin", "linux"],
    binaries: ["alacritty"],
    build(ctx) {
      return {
        file: "alacritty",
        args: ["--working-directory", ctx.cwd, "-e", ...ctx.argv],
        detached: true,
      };
    },
  },
  warp: {
    platforms: ["darwin"],
    apps: ["/Applications/Warp.app"],
    cannotRunCommand: true,
    build(ctx) {
      return { file: "open", args: ["-a", "Warp", ctx.cwd] };
    },
  },
  "gnome-terminal": {
    platforms: ["linux"],
    binaries: ["gnome-terminal"],
    build(ctx) {
      return {
        file: "gnome-terminal",
        args: [`--working-directory=${ctx.cwd}`, "--", ...ctx.argv],
        detached: true,
      };
    },
  },
  konsole: {
    platforms: ["linux"],
    binaries: ["konsole"],
    build(ctx) {
      return { file: "konsole", args: ["--workdir", ctx.cwd, "-e", ...ctx.argv], detached: true };
    },
  },
  xterm: {
    platforms: ["linux"],
    binaries: ["xterm"],
    build(ctx) {
      return { file: "xterm", args: ["-e", "sh", "-c", buildShellLine(ctx)], detached: true };
    },
  },
  "windows-terminal": {
    platforms: ["win32"],
    binaries: ["wt"],
    build(ctx) {
      return { file: "wt", args: ["-d", ctx.cwd, "--", ...ctx.argv] };
    },
  },
};

export function buildLaunchArgv({ config = {}, sessionId, ocx } = {}) {
  const argv = ocx?.OCX_BIN
    ? [ocx.OCX_BIN, "opencode", "-p", ocx.OCX_PROFILE]
    : normalizeLaunchCommand(config.launchCommand ?? ["opencode"]);
  if (sessionId != null && sessionId !== "") {
    argv.push("--session", String(sessionId));
  }
  return argv;
}

function normalizeLaunchCommand(command) {
  if (Array.isArray(command)) {
    if (
      command.length === 0 ||
      command.some((part) => typeof part !== "string" || part.length === 0)
    ) {
      throw new GitwtError(
        "invalid_launch_command",
        "launchCommand должен быть непустым массивом непустых строк",
        { command },
      );
    }
    return [...command];
  }
  if (typeof command === "string" && command.length > 0) {
    return [command];
  }
  throw new GitwtError(
    "invalid_launch_command",
    "launchCommand должен быть строкой или массивом строк",
    {
      command,
    },
  );
}

export function buildTerminalCommand(backend, ctx) {
  const entry = BACKENDS[backend];
  if (!entry) {
    throw new GitwtError("unknown_terminal", `Неизвестный терминал: ${backend}`, {
      terminal: backend,
    });
  }
  return entry.build(normalizeCtx(ctx));
}

function normalizeCtx(ctx = {}) {
  return {
    cwd: ctx.cwd,
    argv: ctx.argv ?? [],
    name: ctx.name ?? "opencode",
    env: ctx.env ?? {},
    platform: ctx.platform ?? process.platform,
  };
}

function defaultHasCommand(env, platform) {
  const raw = env.PATH || env.Path || "";
  const dirs = raw.split(path.delimiter).filter(Boolean);
  const exts =
    platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  return (name) => {
    if (!name) return false;
    const candidates =
      platform === "win32" && path.extname(name) === "" ? exts.map((ext) => name + ext) : [name];
    for (const dir of dirs) {
      for (const candidate of candidates) {
        try {
          fs.accessSync(path.join(dir, candidate), fs.constants.X_OK);
          return true;
        } catch {}
      }
    }
    return false;
  };
}

function defaultHasApp(app) {
  try {
    return fs.existsSync(app);
  } catch {
    return false;
  }
}

function isBackendAvailable(name, { env, platform, hasCommand, hasApp, requireContext = true }) {
  const backend = BACKENDS[name];
  if (!backend) return false;
  if (backend.platforms && !backend.platforms.includes(platform)) return false;
  if (backend.requiresTmux && requireContext && !env.TMUX) return false;
  if (backend.binaries?.some((bin) => hasCommand(bin))) return true;
  if (backend.apps?.some((app) => hasApp(app))) return true;
  return false;
}

function cmuxActive(env) {
  if (env.CMUX_WORKSPACE_ID) return true;
  return Boolean(env.CMUX_SOCKET_PATH && env.CMUX_SOCKET_MODE === "allowAll");
}

function detectFromEnvironment(env, platform) {
  if (platform === "win32") {
    return env.WT_SESSION ? "windows-terminal" : null;
  }
  const fromProgram = TERM_PROGRAM_BACKEND[env.TERM_PROGRAM];
  if (fromProgram) return fromProgram;
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.WEZTERM_PANE) return "wezterm";
  if (env.ALACRITTY_SOCKET) return "alacritty";
  if (env.GHOSTTY_RESOURCES_DIR) return "ghostty";
  return null;
}

export function detectBackend({
  config = {},
  env = process.env,
  platform = process.platform,
  hasCommand,
  hasApp,
} = {}) {
  const requested = config.terminal ?? "auto";
  if (requested !== "auto") return requested;
  const hc = hasCommand ?? defaultHasCommand(env, platform);
  const ha = hasApp ?? defaultHasApp;
  const available = (name) =>
    isBackendAvailable(name, { env, platform, hasCommand: hc, hasApp: ha });

  if (env.TMUX && available("tmux")) return "tmux";
  if (cmuxActive(env) && available("cmux")) return "cmux";

  const fromEnv = detectFromEnvironment(env, platform);
  if (fromEnv && !BACKENDS[fromEnv]?.cannotRunCommand && available(fromEnv)) return fromEnv;

  for (const name of PLATFORM_PRIORITY[platform] ?? PLATFORM_PRIORITY.linux) {
    if (available(name)) return name;
  }
  return null;
}

function windowName(branch, sessionId) {
  const base =
    (branch && String(branch)) ||
    (sessionId ? `session-${String(sessionId).slice(0, 8)}` : "opencode");
  return base.replace(/[\s:]+/g, "-").slice(0, 60) || "opencode";
}

function defaultSpawnDetached(file, args, { cwd, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, detached: true, stdio: "ignore" });
    } catch (error) {
      resolve({ ok: false, error: errorMessage(error) });
      return;
    }
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => done({ ok: false, error: errorMessage(error) }));
    child.once("spawn", () => {
      child.unref();
      done({ ok: true });
    });
  });
}

export async function openTerminal(options = {}) {
  const {
    cwd,
    sessionId,
    branch,
    config = {},
    env = process.env,
    runner = run,
    spawnDetached = defaultSpawnDetached,
    signal,
    platform = process.platform,
    hasCommand,
    hasApp,
  } = options;

  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new GitwtError("invalid_cwd", "cwd обязателен для открытия терминала", { cwd });
  }
  const ocx = resolveOcxContext(env);
  const argv = buildLaunchArgv({ config, sessionId, ocx });
  const childEnv = { ...env, ...ocx };
  const requested = config.terminal ?? "auto";

  if (requested === "none") {
    return { success: true, terminal: "none", argv };
  }

  const hc = hasCommand ?? defaultHasCommand(env, platform);
  const ha = hasApp ?? defaultHasApp;

  let backend;
  if (requested === "auto") {
    backend = detectBackend({ config, env, platform, hasCommand: hc, hasApp: ha });
    if (!backend) {
      return { success: false, error: "Не найден доступный терминал", argv };
    }
  } else {
    backend = requested;
    if (!BACKENDS[backend]) {
      return { success: false, terminal: backend, error: `Неизвестный терминал: ${backend}`, argv };
    }
    if (
      !isBackendAvailable(backend, {
        env,
        platform,
        hasCommand: hc,
        hasApp: ha,
        requireContext: false,
      })
    ) {
      return { success: false, terminal: backend, error: `Терминал ${backend} недоступен`, argv };
    }
  }

  if (BACKENDS[backend].cannotRunCommand) {
    return {
      success: false,
      terminal: backend,
      error: `Терминал ${backend} не умеет запускать команду из CLI. Выполните вручную: ${buildShellLine({ cwd, argv, env: childEnv })}`,
      argv,
    };
  }

  const name = windowName(branch, sessionId);
  const { file, args, detached } = buildTerminalCommand(backend, {
    cwd,
    argv,
    name,
    env: childEnv,
    platform,
  });

  if (detached) {
    let result;
    try {
      result = await spawnDetached(file, args, { cwd, env: childEnv, signal });
    } catch (error) {
      return { success: false, terminal: backend, error: errorMessage(error), argv };
    }
    if (!result?.ok) {
      return {
        success: false,
        terminal: backend,
        error: result?.error ?? `Не удалось запустить ${backend}`,
        argv,
      };
    }
    return { success: true, terminal: backend, argv };
  }

  let result;
  try {
    result = await runner(file, args, { cwd, env: childEnv, signal, allowFailure: true });
  } catch (error) {
    return { success: false, terminal: backend, error: errorMessage(error), argv };
  }
  if (result && typeof result.code === "number" && result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return {
      success: false,
      terminal: backend,
      error: detail || `Терминал ${backend} завершился с кодом ${result.code}`,
      argv,
    };
  }
  return { success: true, terminal: backend, argv };
}
