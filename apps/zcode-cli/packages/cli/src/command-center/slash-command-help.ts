import {
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES,
  type BuiltinZCodeSlashCommandHelpEntry as SlashCommandHelpEntry,
} from "@zcode/shared";
import { withoutSignInCommands } from "../fork/zai-silence/index.js";

export type { SlashCommandHelpEntry };
// fork(zai-silence): the command list offers no sign-in to a Z.ai account
export const SLASH_COMMAND_HELP_ENTRIES = withoutSignInCommands(BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES);
