import path from "node:path";
import { z } from "zod";
import { GitwtError } from "./process.js";
import { forkSession } from "./session.js";
import { buildLaunchArgv, openTerminal, resolveOcxContext } from "./terminal.js";
import { createWorktree, listWorktrees, removeWorktree, updateRecord } from "./worktree.js";

export async function GitwtPlugin({ client, project, directory }, options = {}) {
  let primaryRoot;
  const log = async (message, level = "error") => {
    await client.app.log({ body: { service: "opencode-gitwt", level, message } }).catch(() => {});
  };
  const wrap = (execute) => async (args, ctx) => {
    try {
      return JSON.stringify({ ok: true, ...(await execute(args, ctx)) });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        code: error.code ?? "unexpected_error",
        error: error.message,
        ...error.details,
      });
    }
  };
  const primary = async () => {
    primaryRoot ??= (await listWorktrees(directory))[0].worktreePath;
    return primaryRoot;
  };

  return {
    tool: {
      gitwt_create: {
        description:
          "Создать изолированный Git worktree на свежей remote-ветке, подготовить окружение и открыть отдельную сессию OpenCode. Передайте branch или description. Незакоммиченные изменения исходного worktree не переносятся.",
        args: {
          branch: z.string().optional().describe("Точное имя новой ветки, например feature/login"),
          description: z.string().optional().describe("Описание задачи для создания slug"),
          base: z
            .string()
            .optional()
            .describe("Базовая remote-ветка; по умолчанию trunk/main/master"),
          remote: z.string().optional(),
          from: z
            .string()
            .optional()
            .describe("Явная локальная стартовая ссылка вместо fetch remote-ветки, например HEAD"),
          path: z.string().optional(),
          reuse: z
            .boolean()
            .optional()
            .describe("Подключить существующую свободную ветку вместо создания новой"),
          open: z.boolean().optional().describe("Открыть терминал; по умолчанию true"),
          fork: z
            .boolean()
            .optional()
            .describe("Перенести контекст в новую сессию; по умолчанию настройка forkSession"),
        },
        execute: wrap(async (args, ctx) => {
          if (Boolean(args.branch) === Boolean(args.description)) {
            throw new GitwtError("invalid_name", "Укажите ровно одно из branch или description");
          }
          await primary();
          const ocx = resolveOcxContext(process.env);
          buildLaunchArgv({ config: options, ocx });
          const created = await createWorktree(ctx.directory ?? directory, {
            ...args,
            owner: ctx.sessionID,
            reason: args.description ?? args.branch,
            signal: ctx.abort,
            config: {
              ...options,
              remote: args.remote ?? options.remote,
              base: args.base ?? options.base,
            },
          });
          const { config, ...record } = created;
          let sessionId;
          if (args.fork ?? config.forkSession) {
            try {
              const forked = await forkSession({
                client,
                sessionId: ctx.sessionID,
                projectId: project.id,
                sourceDirectory: ctx.directory ?? directory,
                targetDirectory: record.worktreePath,
                signal: ctx.abort,
              });
              sessionId = forked.sessionId;
              Object.assign(
                record,
                await updateRecord(
                  directory,
                  record.worktreePath,
                  {
                    sessionId,
                    owner: sessionId,
                    contextCopied: forked.contextCopied,
                    status: "ready",
                  },
                  ctx.sessionID,
                ),
              );
            } catch (error) {
              await updateRecord(
                directory,
                record.worktreePath,
                { status: "session_failed", lastError: error.message },
                ctx.sessionID,
              );
              throw new GitwtError(
                "session_failed",
                `Worktree сохранён в ${record.worktreePath}; отдельная сессия не запущена: ${error.message}`,
                { worktreePath: record.worktreePath },
              );
            }
          }
          const command = buildLaunchArgv({ config, sessionId, ocx });
          const terminal =
            args.open === false
              ? { success: true, terminal: "none", argv: command }
              : await openTerminal({
                  cwd: record.worktreePath,
                  sessionId,
                  branch: record.branch,
                  config,
                  signal: ctx.abort,
                });
          if (!terminal.success) {
            Object.assign(
              record,
              await updateRecord(
                directory,
                record.worktreePath,
                { status: "terminal_failed", lastError: terminal.error },
                sessionId ?? ctx.sessionID,
              ),
            );
          }
          return {
            ...record,
            terminal,
            command,
            ...(terminal.success
              ? {}
              : {
                  warning: `Терминал не запущен: ${terminal.error}. Worktree и сессия сохранены.`,
                }),
          };
        }),
      },
      gitwt_list: {
        description:
          "Показать Git worktree, владельцев lease, состояние подготовки и dirty/ahead/behind.",
        args: { status: z.boolean().optional() },
        execute: wrap(async (args) => ({
          worktrees: await listWorktrees(directory, { status: args.status ?? true }),
        })),
      },
      gitwt_remove: {
        description:
          "Явно удалить worktree. Без коммитов и push. Dirty-worktree защищён; force допустим только по явной просьбе пользователя удалить изменения. Lease другого владельца требует его точного ID. Текущая сессия очищается на её следующем idle. Слитая ветка удаляется через git branch -d, неслитая сохраняется с предупреждением.",
        args: {
          branch: z.string(),
          owner: z.string().optional().describe("Владелец lease; по умолчанию ID текущей сессии"),
          force: z.boolean().optional(),
          keepBranch: z.boolean().optional(),
        },
        execute: wrap(async (args, ctx) => {
          const root = await primary();
          const item = (await listWorktrees(root)).find((entry) => entry.branch === args.branch);
          if (!item)
            throw new GitwtError("worktree_missing", `Worktree для ${args.branch} не найден`);
          const removeOptions = {
            owner: args.owner ?? ctx.sessionID,
            force: args.force ?? false,
            deleteBranch: !args.keepBranch,
            config: options,
          };
          if (path.resolve(item.worktreePath) === path.resolve(ctx.directory ?? directory)) {
            await updateRecord(
              root,
              item.worktreePath,
              { pendingRemove: { sessionId: ctx.sessionID, ...removeOptions } },
              removeOptions.owner,
            );
            return {
              pending: true,
              branch: args.branch,
              message: "Удаление запланировано на idle этой сессии",
            };
          }
          return removeWorktree(root, args.branch, { ...removeOptions, signal: ctx.abort });
        }),
      },
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionId = event.properties.sessionID;
      if (typeof sessionId !== "string" || !sessionId) return;
      let root;
      try {
        root = await primary();
      } catch {
        return;
      }
      for (const item of await listWorktrees(root)) {
        const pending = item.state?.pendingRemove;
        if (!pending || pending.sessionId !== sessionId) continue;
        try {
          const removed = await removeWorktree(root, item.branch, pending);
          if (removed.warning) {
            await log(removed.warning, "warn");
            if (client.tui) {
              await client.tui
                .showToast({
                  body: { title: "Ветка сохранена", message: removed.warning, variant: "warning" },
                })
                .catch(() => {});
            }
          }
        } catch (error) {
          await updateRecord(
            root,
            item.worktreePath,
            { pendingRemove: null, status: "remove_failed", lastError: error.message },
            pending.owner,
          ).catch(() => {});
          await log(`Очистка ${item.branch} не выполнена: ${error.message}`);
        }
      }
    },
  };
}

export default { id: "opencode-gitwt", server: GitwtPlugin };
