import type { ChatCommand } from "../../state.js";

export function parseChatCommand(message: string): ChatCommand | undefined {
  switch (message.trim().toLowerCase()) {
    case "help":
      return "help";
    case "orders":
    case "offers":
      return "orders";
    case "withdraw":
      return "withdraw";
    case "balance":
      return "balance";
    default:
      return undefined;
  }
}
