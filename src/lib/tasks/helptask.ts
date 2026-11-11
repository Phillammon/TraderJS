import type { Task } from "../types.js";
import { sendKmailMessage } from "./kmailutils.js";

export const HelpTask: Task = {
  name: "Help",
  done: async (_client, state) => state.helpQueue.length === 0,
  execute: async (client, state) => {
    const playerId = state.peekChatRequest("help");
    if (playerId === undefined) {
      return true;
    }

    await sendKmailMessage(
      client,
      playerId,
      [
        "Hi! I'm TheTrader, your friendly neighbourhood buy order bot.",
        "",
        "Message one of these commands to me:",
        "- help: show these instructions",
        "- orders: list active buy orders",
        "- balance: show your active buy orders and what I'm holding for you",
        "- withdraw: return your available stored meat and items",
        "- cancel [item name or item id]: cancel your buy order for an item",
        "",
        "To create a buy order, send me a one-line note, with or without attached meat:",
        "[optional quantity] x [item name or item id] @ [price per item]",
        "For example: 3 x seal-clubbing club @ 100",
        "The quantity is optional; if omitted, I use as much available meat as possible.",
        "Available meat includes existing surplus and any attached meat. Any remainder goes to surplus.",
        "Surplus meat stays in your account until you request a withdrawal.",
        "Prices must be between 100 and 1,000,000,000 meat per item.",
        "A new order replaces your existing order for that item.",
        "",
        "To fulfil a buy order, send me the items you want to sell.",
      ].join("\n"),
    );
    state.completeChatRequest("help", playerId);
    return true;
  },
};
