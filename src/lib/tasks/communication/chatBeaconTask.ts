import { config } from "../../config.js";
import { getItemName } from "../shared/itemUtils.js";
import { aggregateBuyOrders } from "../../orders.js";
import type { Task } from "../../types.js";

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
    const orders = [...activeOrders.entries()].map(([itemId, priceLevels]) => {
      const highestPrice = Math.max(...priceLevels.keys());
      const quantity = priceLevels.get(highestPrice);
      if (quantity === undefined) {
        throw new Error(
          `Selected buy order for item ${itemId} has no quantity`,
        );
      }
      return { itemId, highestPrice, quantity };
    });
    let advertisement =
      'I can help you make buy orders- message me "help" to find out more!';
    if (orders.length > 0) {
      const selectedIndex = Math.floor(Math.random() * orders.length);
      const selected = orders[selectedIndex];
      if (!selected) {
        throw new Error("Could not select an active buy order for Chat Beacon");
      }
      const { itemId, highestPrice, quantity } = selected;
      advertisement = `I'm buying ${quantity.toLocaleString()}x ${await getItemName(itemId)} at ${highestPrice.toLocaleString()} meat${quantity > 1 ? " each" : ""}${orders.length > 1 ? ", and more!" : "."} Message me "help" to find out more about buy orders!`;
    }
    await client.chat.macro(`/trade ${advertisement}`);
    state.lastBeacon = Date.now();
    return true;
  },
};
