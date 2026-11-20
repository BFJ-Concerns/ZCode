import type { SupportedLocale } from "@zcode/contracts";
import type { ZCodeCopy } from "../../types.js";

/**
 * What the terminal UI says when no configured model can be used: it points at the
 * owner's own providers and offers no sign-in, since the fork has none.
 */
const NO_USABLE_MODEL: Record<SupportedLocale, ZCodeCopy["tui"]["loginRequired"]> = {
  "en-US": {
    help: "Use /model to view models.",
    message: "No available models. Configure a model provider.",
    status: "No available models. Configure a model provider.",
    title: "model setup required",
  },
  "zh-CN": {
    help: "输入 /model 查看模型。",
    message: "没有可用模型，请配置模型 Provider。",
    status: "没有可用模型，请配置模型 Provider。",
    title: "需要配置模型",
  },
};

/** Help lines for commands and options that exist only to sign in to a Z.ai account. */
const SIGN_IN_HELP_LINE = /^\s*(?:login|logout|\/login|\/logout|--no-browser)\b/u;

/** A locale's copy with every offer to sign in to a Z.ai account taken out. */
export function withoutSignIn(locale: SupportedLocale, copy: ZCodeCopy): ZCodeCopy {
  return {
    ...copy,
    cli: {
      ...copy.cli,
      help: (version) =>
        copy.cli
          .help(version)
          .split("\n")
          .filter((line) => !SIGN_IN_HELP_LINE.test(line))
          .join("\n"),
    },
    tui: { ...copy.tui, loginRequired: NO_USABLE_MODEL[locale] },
  };
}
