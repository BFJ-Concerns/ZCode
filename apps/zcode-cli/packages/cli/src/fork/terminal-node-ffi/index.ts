import { isBuiltin, registerHooks } from "node:module";

export async function loadWithOpenTuiFallback<T>(load: () => Promise<T>): Promise<T> {
  if (!isBuiltin("node:ffi")) return await load();

  // OpenTUI selects its FFI backend when it loads. Its node:ffi backend lacks
  // usize support, which the renderer needs. A failed lookup selects Koffi.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:ffi" && context.parentURL?.includes("/@mbears/opentui-core/")) {
        throw new Error("OpenTUI requires the Koffi backend for usize support");
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    return await load();
  } finally {
    hooks.deregister();
  }
}
