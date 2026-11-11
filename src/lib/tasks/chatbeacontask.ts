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
    const preferredOrders =
      orders.filter((order) => order.highestPrice > 1000).length > 0
        ? orders.filter((order) => order.highestPrice > 1000)
        : orders.filter((order) => order.highestPrice > 150);
    const advertisedOrders =
      preferredOrders.length > 0 ? preferredOrders : orders;
    let advertisement =
      'I can help you make buy orders- message me "help" to find out more!';
    if (advertisedOrders.length > 0) {
      const selectedIndex = Math.floor(Math.random() * advertisedOrders.length);
      const selected = advertisedOrders[selectedIndex];
      if (!selected) {
        throw new Error("Could not select an active buy order for Chat Beacon");
      }
      const { itemId, highestPrice, quantity } = selected;
      advertisement = `I'm buying ${quantity.toLocaleString()} x ${await getItemName(itemId)} at ${highestPrice.toLocaleString()} meat${quantity > 1 ? " each" : ""}. Message me "help" to find out more about buy orders!`;
    }
    await client.chat.macro(`/trade ${advertisement}`);
    state.lastBeacon = Date.now();
    return true;
  },
};
