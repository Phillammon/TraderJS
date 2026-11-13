import type { Task } from "../../types.js";

export const PruneProcessedKmailsTask: Task = {
  name: "Prune Processed Kmail IDs",
  done: async (client, state) => {
    const messages = await client.kmail.fetch();
    const inboxIds = new Set(messages.map((message) => message.id));
    return [...state.processedKmailIds].every((id) => inboxIds.has(id));
  },
  execute: async (client, state) => {
    const messages = await client.kmail.fetch();
    const inboxIds = new Set(messages.map((message) => message.id));
    let prunedCount = 0;
    for (const messageId of state.processedKmailIds) {
      if (!inboxIds.has(messageId)) {
        state.processedKmailIds.delete(messageId);
        prunedCount++;
      }
    }
    if (prunedCount > 0) {
      state.save();
      console.log(`Pruned ${prunedCount} processed kmail ID(s) no longer in the inbox.`);
    }
    return true;
  },
};
