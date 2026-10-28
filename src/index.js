import { z } from "zod";
import { createWorktree, listWorktrees, removeWorktree, resolveWorktree } from "./worktree.js";

export async function GitwtPlugin({ directory }, config = {}) {
  return {
    tool: {
      gitwt_create: {
        description:
          "Создать и проверить новый worktree. Продолжайте текущую сессию, используя возвращённый worktreePath в командах и файловых операциях. Сохраняйте worktree при паузе и передаче задачи.",
        args: {
          branch: z.string().describe("Имя новой ветки"),
          base: z.string().optional().describe("Базовая remote-ветка"),
          from: z
            .string()
            .optional()
            .describe("Явная локальная ссылка или проверенный commit вместо remote-базы"),
          path: z.string().optional().describe("Полный путь нового worktree"),
          noHooks: z.boolean().optional().describe("Явно отключить хуки для создаваемого worktree"),
        },
        execute: async (args, ctx) =>
          JSON.stringify(
            await createWorktree(ctx.directory ?? directory, {
              ...args,
              signal: ctx.abort,
              config: { ...config, base: args.base ?? config.base },
            }),
          ),
      },
      gitwt_list: {
        description:
          "Показать worktree из реестра Git. status добавляет dirty и доступные ahead/behind; отсутствие этих полей означает неизвестное состояние.",
        args: { status: z.boolean().optional() },
        execute: async (args, ctx) =>
          JSON.stringify(await listWorktrees(ctx.directory ?? directory, args)),
      },
      gitwt_cd: {
        description:
          "Найти worktree по точной ветке или полному пути и вернуть его путь, HEAD и статус. Каталог текущей сессии не меняется: используйте worktreePath явно.",
        args: { target: z.string() },
        execute: async ({ target }, ctx) =>
          JSON.stringify(
            await resolveWorktree(ctx.directory ?? directory, target, { status: true }),
          ),
      },
      gitwt_remove: {
        description:
          "Только по явной просьбе удалить указанный worktree, убедившись, что он больше не используется. force разрешает потерю изменений, но не обходит ошибку preRemove. Без автокоммитов и отложенной очистки.",
        args: {
          target: z.string(),
          force: z.boolean().optional(),
          keepBranch: z.boolean().optional(),
        },
        execute: async ({ target, force, keepBranch }, ctx) =>
          JSON.stringify(
            await removeWorktree(ctx.directory ?? directory, target, {
              force,
              deleteBranch: !keepBranch,
              signal: ctx.abort,
            }),
          ),
      },
    },
  };
}

export default { id: "opencode-gitwt", server: GitwtPlugin };
