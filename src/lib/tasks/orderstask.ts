import { getItemName } from "./itemutils.js";
import { sendKmailMessage } from "./kmailutils.js";
import { aggregateBuyOrders, getOrderQuantity } from "../orders.js";
import type { Task } from "../types.js";

export const OrdersTask: Task = {
  name: "Orders",
  done: async (_client, state) => state.ordersQueue.length === 0,
  execute: async (client, state) => {
    const playerId = state.peekChatRequest("orders");
    if (playerId === undefined) {
      return true;
    }

    const ownOrders = state.getPlayer(playerId).orders;
    const ownLines = await Promise.all(
      [...ownOrders.entries()]
        .filter(([, order]) => order.meat > 0 && order.price > 0)
        .map(async ([itemId, order]) => {
          const itemName = await getItemName(itemId);
          const quantity = getOrderQuantity(order.meat, order.price);
          return [
            `- ${itemName} (ID ${itemId})`,
            `    - ${quantity.toLocaleString()} items at ${order.price.toLocaleString()} meat each (${order.meat.toLocaleString()} meat reserved)`,
          ].join("\n");
        }),
    );
    const aggregatedOrders = aggregateBuyOrders(state.players);
    const marketLines = await Promise.all(
      [...aggregatedOrders.entries()].map(async ([itemId, priceLevels]) => {
        const itemName = await getItemName(itemId);
        const levels = [...priceLevels.entries()].sort(
          ([priceA], [priceB]) => priceB - priceA,
        );
        const highestLevels = levels.slice(0, 3).map(([price, quantity]) => {
          return `    - ${quantity.toLocaleString()} at ${price.toLocaleString()} meat each`;
        });
        const lowerQuantity = levels
          .slice(3)
          .reduce((total, [, quantity]) => total + quantity, 0);
        if (lowerQuantity > 0) {
          highestLevels.push(
            `    - And ${lowerQuantity.toLocaleString()} more at lower prices`,
          );
        }
        return `- ${itemName} (ID ${itemId})\n${highestLevels.join("\n")}`;
      }),
    );
    await sendKmailMessage(
      client,
      playerId,
      [
        "Your active buy orders:",
        ownLines.length ? ownLines.join("\n") : "- None",
        "",
        "All active buy orders by item (highest prices first):",
        marketLines.length ? marketLines.join("\n") : "- None",
      ].join("\n"),
    );
    state.completeChatRequest("orders", playerId);
    return true;
  },
};
