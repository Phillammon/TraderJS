import { config } from "../../config.js";
import type { Task } from "../../types.js";
import {
  finishKmailProcessing,
  getKmailAction,
  hasUnopenedGiftPackages,
  processIncomingKmail,
} from "./buyOrderWorkflow.js";

export const ParseKmailTask: Task = {
  name: "Parse Kmail",
  done: async (client, state) => {
    if (await hasUnopenedGiftPackages(client)) {
      return true;
    }

    const messages = await client.kmail.fetch();
    return !messages.some(
      (message) =>
        !state.processedKmailIds.has(message.id) &&
        !state.pendingKmailActions.has(message.id),
    );
  },
  execute: async (client, state) => {
    if (await hasUnopenedGiftPackages(client)) {
      return true;
    }

    const messages = await client.kmail.fetch();
    const pendingMessages = messages.filter(
      (message) => !state.processedKmailIds.has(message.id),
    );
    const processingOrder = [
      ...pendingMessages.filter(
        (message) => message.who.id !== config.OPERATOR_ID,
      ),
      ...pendingMessages.filter(
        (message) => message.who.id === config.OPERATOR_ID,
      ),
    ];
    for (const message of processingOrder) {
      state.setPlayerName(message.who.id, message.who.name);
      const action = getKmailAction(message);
      if (action) {
        state.queueKmailAction(message.id, action);
        state.save();
        continue;
      }

      const result = await processIncomingKmail(client, message, state);
      finishKmailProcessing(message, result, state);
    }

    return true;
  },
};
