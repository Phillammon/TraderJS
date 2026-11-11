import type { Task } from "../../types.js";
import {
  processQueuedChatBuyOrders,
  processQueuedKmailAction,
} from "./buyOrderWorkflow.js";

export const CreateBuyOrderTask: Task = {
  name: "Create Buy Order",
  done: async (_client, state) =>
    ![...state.pendingKmailActions.values()].includes("create") &&
    state.pendingChatBuyOrders.size === 0,
  execute: async (client, state) => {
    await processQueuedKmailAction(client, state, "create");
    await processQueuedChatBuyOrders(client, state);
    return true;
  },
};
