import { getItemName } from "../shared/itemUtils.js";
import {
  getOrderQuantity,
  getReservedOrderMeat,
  getWithdrawableAssets,
} from "../../orders.js";
import { prepareWithdrawalReport } from "./withdrawalSupport.js";
import { sendKmailMessage } from "../communication/kmailUtils.js";
import { PROMOTIONAL_ACCOUNT_ID } from "../../state.js";
import { getCommandAccountId, getCurrentMeat } from "./commandAccount.js";
import type { Task } from "../../types.js";

export const BalanceTask: Task = {
  name: "Balance",
  done: async (_client, state) => state.balanceQueue.length === 0,
  execute: async (client, state) => {
    const playerId = state.peekChatRequest("balance");
    if (playerId === undefined) {
      return true;
    }

    const accountId = getCommandAccountId(playerId);
    const player = state.getPlayer(accountId);
    if (accountId === PROMOTIONAL_ACCOUNT_ID) {
      state.syncPromotionalAccount(await getCurrentMeat(client));
    }
    const available = getWithdrawableAssets(player);
    const withdrawal = await prepareWithdrawalReport(player, available);
    const reservedMeat = getReservedOrderMeat(player);
    const orders = await Promise.all(
      [...player.orders.entries()]
        .filter(([, order]) => order.meat > 0 && order.price > 0)
        .map(async ([itemId, order]) => {
          const itemName = await getItemName(itemId);
          const quantity = getOrderQuantity(order.meat, order.price);
          return `- ${itemName} (ID ${itemId}): ${order.meat.toLocaleString()} meat reserved; ${quantity.toLocaleString()} at ${order.price.toLocaleString()} meat each`;
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
        accountId === playerId
          ? "Your current balance"
          : "The bot's promotional balance",
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
