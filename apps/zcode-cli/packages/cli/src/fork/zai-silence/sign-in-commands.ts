/** Slash commands that exist only to sign in to, or out of, a Z.ai account. */
const SIGN_IN_COMMANDS: ReadonlySet<string> = new Set(["login", "logout"]);

/** The slash command help entries with the sign-in commands taken out. */
export function withoutSignInCommands<Entry extends { readonly name: string }>(
  entries: readonly Entry[],
): readonly Entry[] {
  return entries.filter((entry) => !SIGN_IN_COMMANDS.has(entry.name));
}
