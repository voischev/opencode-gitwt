import { createWorktree, listWorktrees, removeWorktree, resolveWorktree } from "@voischev/gitwt";
import { z } from "zod";

export async function GitwtPlugin({ directory }, config = {}) {
  return {
    tool: {
      gitwt_create: {
        description:
          "Create and verify a new worktree. Use worktreePath for commands and files in the current session. Keep the worktree when pausing or handing off a task.",
        args: {
          branch: z.string().describe("New branch name"),
          base: z.string().optional().describe("Remote base branch"),
          from: z
            .string()
            .optional()
            .describe("Local ref or verified commit instead of a remote base"),
          path: z.string().optional().describe("Destination path"),
          noHooks: z.boolean().optional().describe("Disable hooks for this worktree"),
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
          "List Git worktrees. With status, check dirty and available ahead/behind counts; null means unknown.",
        args: { status: z.boolean().optional().describe("Check live worktree status") },
        execute: async (args, ctx) =>
          JSON.stringify(await listWorktrees(ctx.directory ?? directory, args)),
      },
      gitwt_cd: {
        description:
          "Resolve a branch or full path to a worktree with HEAD and status. Use worktreePath explicitly; this does not change the session directory.",
        args: { target: z.string().describe("Exact branch name or full worktree path") },
        execute: async ({ target }, ctx) =>
          JSON.stringify(
            await resolveWorktree(ctx.directory ?? directory, target, { status: true }),
          ),
      },
      gitwt_remove: {
        description:
          "Remove a worktree only when explicitly requested and no longer in use. Force discards local changes but does not bypass a failing preRemove hook.",
        args: {
          target: z.string().describe("Exact branch name or full worktree path"),
          force: z.boolean().optional().describe("Allow discarding local changes"),
          keepBranch: z
            .boolean()
            .optional()
            .describe("Keep the branch after removing the worktree"),
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
