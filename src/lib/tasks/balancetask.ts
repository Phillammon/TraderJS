import { getItemName } from "./itemutils.js";
import {
  getOrderQuantity,
  getReservedOrderMeat,
  getWithdrawableAssets,
} from "../orders.js";
import { prepareWithdrawalReport } from "./withdrawalsupport.js";
import { sendKmailMessage } from "./kmailutils.js";
import type { Task } from "../types.js";

export const BalanceTask: Task = {
  name: "Balance",
  done: async (_client, state) => state.balanceQueue.length === 0,
  execute: async (client, state) => {
    const playerId = state.peekChatRequest("balance");
    if (playerId === undefined) {
      return true;
    }

    const player = state.getPlayer(playerId);
    const available = getWithdrawableAssets(player);
    const withdrawal = await prepareWithdrawalReport(player, available);
    const reservedMeat = getReservedOrderMeat(player);
    const orders = await Promise.all(
      [...player.orders.entries()]
        .filter(([, order]) => order.meat > 0 && order.price > 0)
        .map(async ([itemId, order]) => {
          const itemName = await getItemName(itemId);
          const quantity = getOrderQuantity(order.meat, order.price);
          return `- ${itemName} (ID ${itemId}): ${order.meat.toLocaleString()} meat reserved; ${quantity.toLocaleString()} items at ${order.price.toLocaleString()} meat each`;
        }),
    );
    const returnItemCount = [...available.items.values()].reduce(
      (total, quantity) => total + quantity,
      0,
    );
    const takeaway = [
      `If withdrawn now: ${available.meat.toLocaleString()} meat and ${returnItemCount.toLocaleString()} items across ${available.items.size} item type(s).`,
      `Reserved for active orders: ${reservedMeat.toLocaleString()} meat.`,
    ];

    await sendKmailMessage(
      client,
      playerId,
      [
        "Your current balance",
        "",
        ...takeaway,
        "",
        "Active buy orders (allocated meat):",
        orders.length ? orders.join("\n") : "- None",
        "",
        withdrawal.message,
      ].join("\n"),
    );
    state.completeChatRequest("balance", playerId);
    return true;
  },
};
