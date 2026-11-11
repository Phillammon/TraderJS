import { config } from "../config.js";
import { getItemName } from "./itemutils.js";
import { aggregateBuyOrders } from "../orders.js";
import type { Task } from "../types.js";

export const ChatBeaconTask: Task = {
  name: "Announce In Chat",
  done: async (_client, state) =>
    Date.now() - state.lastBeacon < config.TRADE_BEACON_DELAY * 1000,
  execute: async (client, state) => {
    const now = Date.now();
    if (now - state.lastBeacon < config.TRADE_BEACON_DELAY * 1000) {
      return true;
    }

    const activeOrders = aggregateBuyOrders(state.players);
    const items = [...activeOrders.entries()];
    let advertisement =
      'I can help you make buy orders- message me "help" to find out more!';
    if (items.length > 0) {
      const selectedIndex = Math.floor(Math.random() * items.length);
      const selected = items[selectedIndex];
      if (!selected) {
        throw new Error("Could not select an active buy order for Chat Beacon");
      }
      const [itemId, priceLevels] = selected;
      const highestPrice = [...priceLevels.keys()].reduce(
        (highest, price) => Math.max(highest, price),
        0,
      );
      const quantity = priceLevels.get(highestPrice);
      if (quantity === undefined) {
        throw new Error(
          `Selected buy order for item ${itemId} has no quantity`,
        );
      }
      advertisement = `I'm buying ${quantity.toLocaleString()} x ${await getItemName(itemId)} at ${highestPrice.toLocaleString()} meat${quantity > 1 ? " each" : ""}. Message me "help" to find out more about buy orders!`;
    }
    await client.chat.macro(`/trade ${advertisement}`);
    state.lastBeacon = Date.now();
    return true;
  },
};
