import { config } from "../config.js";
import type { ChatCommand } from "../state.js";
import {
  queueUnrecognizedChatMessage,
} from "./operator.js";
import { sendKmailMessage } from "./kmailutils.js";
import type { Task } from "../types.js";

const COMMANDS: readonly ChatCommand[] = [
  "help",
  "orders",
  "withdraw",
  "balance",
];

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
      const cancelMatch = /^cancel\s+(.+)$/i.exec(message.msg.trim());
      if (cancelMatch) {
        state.enqueueCancelRequest(message.who.id, cancelMatch[1]!);
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
      const requestedCommand = message.msg.trim().toLowerCase();
      const command = COMMANDS.find(
        (supportedCommand) => supportedCommand === requestedCommand,
      );
      if (command) {
        state.enqueueChatRequest(command, message.who.id);
      } else {
        queueUnrecognizedChatMessage(state, message);
        await client.chat.send(
          message.who.id,
          'I don\'t recognize that command. Whisper "help" to see what I can do.',
        );
      }
    }
    state.lastChatPoll = Date.now();
    state.save();
    return true;
  },
};
