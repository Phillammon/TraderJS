import type { ChatCommand } from "../../state.js";

const CHAT_COMMANDS: readonly ChatCommand[] = [
  "help",
  "orders",
  "withdraw",
  "balance",
];

export function parseChatCommand(message: string): ChatCommand | undefined {
  const requestedCommand = message.trim().toLowerCase();
  return CHAT_COMMANDS.find((command) => command === requestedCommand);
}
