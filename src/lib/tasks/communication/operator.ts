import { createHash } from "node:crypto";
import type { Client } from "kol.js";
import { config } from "../../config.js";
import type { TraderState } from "../../state.js";
import type { Task } from "../../types.js";
import { sendKmailMessage } from "./kmailUtils.js";

type ChatMessage = Awaited<ReturnType<Client["chat"]["fetch"]>>[number];

export function queueUnrecognizedChatMessage(
  state: TraderState,
  message: ChatMessage,
): void {
  const timestamp = Number.isNaN(message.time.getTime())
    ? "invalid timestamp"
    : message.time.toISOString();
  const notificationId = createHash("sha256")
    .update(JSON.stringify([message.who.id, timestamp, message.msg]))
    .digest("hex");
  state.queueOperatorNotification(
    `chat:${notificationId}`,
    [
      `Rejected private chat message from ${message.who.name} (player ${message.who.id}) at ${timestamp}.`,
      "Reason: the message did not match a supported command.",
      "Quoted message:",
      quoteMessage(message.msg),
    ].join("\n"),
  );
}

export const OperatorNotificationsTask: Task = {
  name: "Operator Notifications",
  done: async (_client, state) => state.pendingOperatorNotifications.size === 0,
  execute: async (client, state) => {
    if (!Number.isSafeInteger(config.OPERATOR_ID) || config.OPERATOR_ID <= 0) {
      throw new RangeError("OPERATOR_ID must be a positive safe integer");
    }

    for (const [
      notificationId,
      message,
    ] of state.pendingOperatorNotifications) {
      await sendKmailMessage(client, config.OPERATOR_ID, message);
      state.completeOperatorNotification(notificationId);
      state.save();
    }
    return true;
  },
};

export function quoteMessage(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}
