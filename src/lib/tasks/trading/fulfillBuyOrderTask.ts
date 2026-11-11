import type { Task } from "../../types.js";
import { processQueuedKmailAction } from "./buyOrderWorkflow.js";

export const FulfilBuyOrderTask: Task = {
  name: "Fulfil Buy Order",
  done: async (_client, state) =>
    ![...state.pendingKmailActions.values()].includes("fulfill"),
  execute: async (client, state) =>
    processQueuedKmailAction(client, state, "fulfill"),
};
