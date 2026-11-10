import type { Task } from "../types.js";
import { sendKmailMessage } from "./kmailutils.js";

export const KmailRepliesTask: Task = {
  name: "Kmail Replies",
  done: async (_client, state) => state.pendingKmailReplies.size === 0,
  execute: async (client, state) => {
    for (const [kmailId, reply] of state.pendingKmailReplies) {
      await sendKmailMessage(client, reply.playerId, reply.message);
      state.completeKmailReply(kmailId);
      state.save();
    }
    return true;
  },
};
