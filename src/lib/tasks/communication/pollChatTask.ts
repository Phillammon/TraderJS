import { createHash } from "node:crypto";
import { config } from "../../config.js";
import { parseChatCommand } from "./chatCommands.js";
import { queueUnrecognizedChatMessage } from "./operator.js";
import { sendKmailMessage } from "./kmailUtils.js";
import type { Task } from "../../types.js";

export const PollChatTask: Task = {
  name: "Poll Chat",
  done: async (_client, state) =>
    Date.now() - state.lastChatPoll < config.CHAT_POLL_DELAY * 1000,
  execute: async (client, state) => {
    const messages = await client.chat.fetch();
    for (const message of messages) {
      if (message.type !== "private") {
        continue;
      }
      state.setPlayerName(message.who.id, message.who.name);
      if (message.msg.includes("@")) {
        const timestamp = Number.isNaN(message.time.getTime())
          ? "invalid timestamp"
          : message.time.toISOString();
        const id = createHash("sha256")
          .update(JSON.stringify([message.who.id, timestamp, message.msg]))
          .digest("hex");
        state.enqueueChatBuyOrder({
          id,
          playerId: message.who.id,
          playerName: message.who.name,
          message: message.msg,
          timestamp,
        });
        continue;
      }
      const cancelMatch = /^cancel\s+(.+)$/i.exec(message.msg.trim());
      if (cancelMatch) {
        state.enqueueCancelRequest(
          message.who.id,
          cancelMatch[1]!,
          message.who.name,
        );
        continue;
      }
      if (/^cancel$/i.test(message.msg.trim())) {
        state.queueOperatorNotification(
          `chat-cancel:${message.who.id}:${Date.now()}`,
          `Player ${message.who.id} sent an invalid cancel command without an item selector. Quoted message: "${message.msg}"`,
        );
        await sendKmailMessage(
          client,
          message.who.id,
          'Please include an item name or ID, for example: "cancel seal-clubbing club".',
        );
        continue;
      }
      const command = parseChatCommand(message.msg);
      if (command) {
        state.enqueueChatRequest(command, message.who.id);
      } else {
        queueUnrecognizedChatMessage(state, message);
        await client.chat.send(
          message.who.id,
          'I don\'t recognize that command. Message ne "help" to see what I can do.',
        );
      }
    }
    state.lastChatPoll = Date.now();
    state.save();
    return true;
  },
};
