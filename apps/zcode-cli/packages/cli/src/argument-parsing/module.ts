/**
 * cli-arguments 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliArgumentsModule = {
  id: "cli-arguments",
  // fork(per-run-model): declare the CLI module that supplies the model options
  requires: ["zcode-cli"],
  provides: ["cli-arguments"],
  publicEntrypoints: ["../arguments.ts", "contract.ts"],
} as const;
