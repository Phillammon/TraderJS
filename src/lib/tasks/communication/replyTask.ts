import { gameData } from "kol.js";
import type { Item } from "data-of-loathing";
import type { Task } from "../../types.js";
import { sendKmailMessage } from "./kmailUtils.js";

export const KmailRepliesTask: Task = {
  name: "Kmail Replies",
  done: async (_client, state) => state.pendingKmailReplies.size === 0,
  execute: async (client, state) => {
    for (const [kmailId, reply] of state.pendingKmailReplies) {
      const items = new Map<Item, number>();
      const itemQuantities = new Map<number, number>();
      for (const [itemIdText, quantity] of Object.entries(reply.items ?? {})) {
        const itemId = Number(itemIdText);
        const item = await gameData.findItemById(itemId);
        if (!item) {
          throw new Error(
            `Could not find item ${itemId} for kmail reply ${kmailId}`,
          );
        }
        items.set(item, quantity);
        itemQuantities.set(itemId, quantity);
      }

      await sendKmailMessage(
        client,
        reply.playerId,
        reply.message,
        items.size > 0 ? { items } : undefined,
      );
      if (itemQuantities.size > 0) {
        state.recordSent(reply.playerId, 0, itemQuantities, {
          meat: 0,
          items: itemQuantities,
        });
      }
      state.completeKmailReply(kmailId);
      state.save();
    }
    return true;
  },
};
