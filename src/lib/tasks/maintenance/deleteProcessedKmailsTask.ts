import type { Task } from "../../types.js";

export const DeleteProcessedKmailTask: Task = {
  name: "Delete Processed Kmails",
  done: async (client, state) => {
    const messages = await client.kmail.fetch();
    return !messages.some(
      (message) =>
        state.processedKmailIds.has(message.id) &&
        !state.pendingKmailReplies.has(String(message.id)),
    );
  },
  execute: async (client, state) => {
    const messages = await client.kmail.fetch();
    const messageIdsToDelete = messages
      .filter(
        (message) =>
          state.processedKmailIds.has(message.id) &&
          !state.pendingKmailReplies.has(String(message.id)),
      )
      .map((message) => message.id);

    if (messageIdsToDelete.length === 0) {
      return true;
    }
    if (!(await client.kmail.delete(messageIdsToDelete))) {
      throw new Error(
        `Could not delete processed kmail messages: ${messageIdsToDelete.join(", ")}`,
      );
    }
    for (const messageId of messageIdsToDelete) {
      state.processedKmailIds.delete(messageId);
    }
    state.save();
    return true;
  },
};
