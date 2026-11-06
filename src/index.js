import {
  createWorktree,
  GitwtError,
  listWorktrees,
  removeWorktree,
  resolveWorktree,
} from "@voischev/gitwt";

export async function GitwtPlugin({ directory }, config = {}) {
  const tool = {
    gitwt_create: {
      description:
        "Create and verify a new worktree. Use worktreePath for commands and files in the current session. Keep the worktree when pausing or handing off a task.",
      args: {
        branch: { type: "string", description: "New branch name" },
        base: { type: "string", description: "Remote base branch" },
        from: {
          type: "string",
          description: "Local ref or verified commit instead of a remote base",
        },
        path: { type: "string", description: "Destination path" },
        noHooks: { type: "boolean", description: "Disable hooks for this worktree" },
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
      args: { status: { type: "boolean", description: "Check live worktree status" } },
      execute: async (args, ctx) =>
        JSON.stringify(await listWorktrees(ctx.directory ?? directory, args)),
    },
    gitwt_cd: {
      description:
        "Resolve a branch or full path to a worktree with HEAD and status. Use worktreePath explicitly; this does not change the session directory.",
      args: { target: { type: "string", description: "Exact branch name or full worktree path" } },
      execute: async ({ target }, ctx) =>
        JSON.stringify(await resolveWorktree(ctx.directory ?? directory, target, { status: true })),
    },
    gitwt_remove: {
      description:
        "Remove a worktree only when explicitly requested and no longer in use. Force discards local changes but does not bypass a failing preRemove hook.",
      args: {
        target: { type: "string", description: "Exact branch name or full worktree path" },
        force: { type: "boolean", description: "Allow discarding local changes" },
        keepBranch: { type: "boolean", description: "Keep the branch after removing the worktree" },
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
  };
  const required = {
    gitwt_create: ["branch"],
    gitwt_list: [],
    gitwt_cd: ["target"],
    gitwt_remove: ["target"],
  };
  for (const [id, definition] of Object.entries(tool)) {
    const execute = definition.execute;
    definition.execute = async (args, ctx) => {
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new GitwtError("invalid_arguments", `${id}: expected an argument object`);
      }
      for (const key of Object.keys(args)) {
        if (!Object.hasOwn(definition.args, key)) {
          throw new GitwtError("invalid_arguments", `${id}: unknown argument ${key}`);
        }
      }
      for (const [key, schema] of Object.entries(definition.args)) {
        if (args[key] === undefined && !required[id].includes(key)) continue;
        if (typeof args[key] !== schema.type) {
          throw new GitwtError("invalid_arguments", `${id}: ${key} must be ${schema.type}`);
        }
      }
      return execute(args, ctx);
    };
  }
  return {
    tool,
    "tool.definition": async ({ toolID }, output) => {
      if (!Object.hasOwn(tool, toolID)) return;
      output.jsonSchema = {
        type: "object",
        properties: tool[toolID].args,
        required: required[toolID],
        additionalProperties: false,
      };
    },
  };
}

export default { id: "opencode-gitwt", server: GitwtPlugin };
