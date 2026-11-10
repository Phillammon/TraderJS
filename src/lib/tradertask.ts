import { gameData, type Client } from "kol.js";
import { relevantItemsAndEffects } from "./gameconstants.js";
import { getActiveBuyOrdersForItem, getOrderQuantity } from "./orders.js";
import { quoteMessage } from "./operator.js";
import {
  MAX_BUY_ORDER_PRICE,
  MIN_BUY_ORDER_PRICE,
  type BuyOrder,
  type PlayerState,
  type TraderState,
} from "./state.js";
import type { Task } from "./types.js";

type Kmail = Awaited<ReturnType<Client["kmail"]["fetch"]>>[number];
type Fulfillment = {
  buyerId: number;
  player: PlayerState;
  itemId: number;
  quantity: number;
  price: number;
  order: BuyOrder;
};
type KmailProcessingResult = {
  reply?: string;
  rejectionReason?: string;
};

export const TraderTask: Task = {
  name: "Trader",
  done: async (client, state) => {
    if (await hasUnopenedGiftPackages(client)) {
      return true;
    }

    const messages = await client.kmail.fetch();
    return !messages.some(
      (message) => !state.processedKmailIds.has(message.id),
    );
  },
  execute: async (client, state) => {
    if (await hasUnopenedGiftPackages(client)) {
      return true;
    }

    const messages = await client.kmail.fetch();
    for (const message of messages) {
      if (state.processedKmailIds.has(message.id)) {
        continue;
      }

      const result = await processIncomingKmail(message, state);
      state.markKmailProcessed(
        message.id,
        result.reply
          ? { playerId: message.who.id, message: result.reply }
          : undefined,
      );
      if (result.rejectionReason) {
        state.queueOperatorNotification(
          `kmail:${message.id}`,
          formatRejectedKmail(message, result.rejectionReason),
        );
      }
      state.save();
    }

    return true;
  },
};

async function hasUnopenedGiftPackages(client: Client): Promise<boolean> {
  const inventory = await client.inventory.get();
  return relevantItemsAndEffects.PACKAGES.some(
    (giftPackage) => (inventory.get(giftPackage) ?? 0) > 0,
  );
}

function isGiftPackage(itemId: number): boolean {
  return relevantItemsAndEffects.PACKAGES.some(
    (giftPackage) => giftPackage.id === itemId,
  );
}

function hasAssets(message: Kmail): boolean {
  return message.meat > 0 || message.items.size > 0;
}

async function processIncomingKmail(
  message: Kmail,
  state: TraderState,
): Promise<KmailProcessingResult> {
  const senderId = message.who.id;
  const receivedItems = new Map(
    [...message.items].map(([item, quantity]) => [item.id, quantity]),
  );
  const receivedMeat = message.meat;
  if (Number.isNaN(message.time.getTime())) {
    const reason = "The kmail had an invalid timestamp.";
    state.recordSurplus(senderId, receivedMeat, receivedItems, new Date());
    return {
      reply: `I couldn't process this kmail because it had an invalid timestamp. All attached meat and items have been added to surplus. ${await formatSurplusBalance(state, senderId)}`,
      rejectionReason: reason,
    };
  }
  const realItems = [...receivedItems.keys()].filter(
    (itemId) => !isGiftPackage(itemId),
  );
  if (receivedMeat > 0 && realItems.length > 0) {
    state.recordSurplus(senderId, receivedMeat, receivedItems, message.time);
    return {
      reply: `I can't process a kmail that contains both meat and non-package items. All attached meat and items have been added to surplus. Please send meat and items in separate kmails. ${await formatSurplusBalance(state, senderId)}`,
      rejectionReason:
        "The kmail contained both meat and non-package items; all attached resources were credited to sender surplus.",
    };
  }
  if (receivedMeat === 0 && realItems.length === 0) {
    state.recordSurplus(senderId, receivedMeat, receivedItems, message.time);
    return {
      reply: [
        "I couldn't understand what you wanted because this kmail contained no meat or items.",
        "To create a buy order, send meat with a note in the format `[item name or item id] @ [price]` (100 to 1,000,000,000 meat per item).",
        "To fulfil a buy order, send the item(s) you want to sell.",
        'Whisper "help" for commands and more information.',
      ].join("\n"),
      rejectionReason: "The kmail contained no assets.",
    };
  }

  const parsedOrder =
    receivedMeat > 0
      ? await parseBuyOrder(message.msg).catch((error: unknown) => ({
          ok: false as const,
          reason: `Could not parse the order note: ${error instanceof Error ? error.message : String(error)}`,
        }))
      : undefined;
  const orderPlan =
    parsedOrder && parsedOrder.ok && parsedOrder.price <= receivedMeat
      ? {
          item: parsedOrder.item,
          price: parsedOrder.price,
          quantity: Math.floor(receivedMeat / parsedOrder.price),
          allocatedMeat:
            Math.floor(receivedMeat / parsedOrder.price) * parsedOrder.price,
        }
      : undefined;
  if (orderPlan) {
    const previousOrderMeat =
      state.getPlayer(senderId).orders.get(orderPlan.item.id)?.meat ?? 0;
    const postOrderSurplus =
      state.getPlayer(senderId).surplusMeat +
      receivedMeat -
      orderPlan.allocatedMeat +
      previousOrderMeat;
    if (!Number.isSafeInteger(postOrderSurplus)) {
      throw new RangeError("Buy order surplus exceeds safe limits");
    }
  }
  const fulfillments: Fulfillment[] = [];
  for (const [itemId, quantity] of receivedItems) {
    if (isGiftPackage(itemId)) {
      continue;
    }
    let remainingQuantity = quantity;
    const orders = getActiveBuyOrdersForItem(state.players, itemId, senderId);

    for (const { playerId, player, order } of orders) {
      if (remainingQuantity === 0) {
        break;
      }

      const orderQuantity = getOrderQuantity(order.meat, order.price);
      const fulfilledQuantity = Math.min(remainingQuantity, orderQuantity);
      if (fulfilledQuantity === 0) {
        continue;
      }

      fulfillments.push({
        buyerId: playerId,
        player,
        itemId,
        quantity: fulfilledQuantity,
        price: order.price,
        order,
      });
      remainingQuantity -= fulfilledQuantity;
    }
  }

  validateFulfillments(senderId, receivedMeat, fulfillments, state);
  state.recordSurplus(senderId, 0, receivedItems, message.time, false);
  const surplusItems = new Map(receivedItems);

  for (const fulfillment of fulfillments) {
    const { buyerId, itemId, quantity, price, player, order } = fulfillment;
    const totalPrice = quantity * price;
    state.recordPurchase(buyerId, itemId, quantity, price, message.time, false);
    state.recordSale(senderId, itemId, quantity, price, message.time, false);
    state.recordTradeAudit(
      senderId,
      buyerId,
      itemId,
      quantity,
      price,
      message.time,
    );
    order.meat -= totalPrice;
    surplusItems.set(itemId, (surplusItems.get(itemId) ?? 0) - quantity);
    if (order.meat === 0) {
      player.orders.delete(itemId);
    }
  }
  for (const [itemId, quantity] of surplusItems) {
    if (quantity <= 0) {
      surplusItems.delete(itemId);
    }
  }
  state.recordSurplusAudit(senderId, 0, surplusItems, message.time);

  if (receivedMeat <= 0) {
    return {};
  }

  if (!parsedOrder) {
    throw new Error("Kmail with meat did not produce an order parse result");
  }
  if (!parsedOrder.ok) {
    state.recordSurplus(senderId, receivedMeat, new Map(), message.time, false);
    state.recordSurplusAudit(senderId, receivedMeat, new Map(), message.time);
    return {
      reply: `I couldn't create a buy order from your kmail: ${parsedOrder.reason} I have added all ${receivedMeat.toLocaleString()} meat to your surplus balance. ${await formatSurplusBalance(state, senderId)}`,
      rejectionReason: parsedOrder.reason,
    };
  }

  if (parsedOrder.price > receivedMeat) {
    state.recordSurplus(senderId, receivedMeat, new Map(), message.time, false);
    state.recordSurplusAudit(senderId, receivedMeat, new Map(), message.time);
    const rejectionReason = `The requested price of ${parsedOrder.price.toLocaleString()} meat per item exceeds the ${receivedMeat.toLocaleString()} meat attached.`;
    return {
      reply: `I couldn't create a buy order for ${parsedOrder.item.name}: the price of ${parsedOrder.price.toLocaleString()} meat per item is greater than the ${receivedMeat.toLocaleString()} meat you sent. All sent meat has been added to your surplus balance. ${await formatSurplusBalance(state, senderId)}`,
      rejectionReason,
    };
  }

  if (!orderPlan) {
    throw new Error("Valid order text did not produce a valid buy order");
  }
  state.recordSurplus(senderId, receivedMeat, new Map(), message.time, false);
  const releasedMeat = state.createBuyOrderFromSurplus(
    senderId,
    orderPlan.item.id,
    orderPlan.allocatedMeat,
    orderPlan.price,
    message.time,
  );
  const surplusMeat = receivedMeat - orderPlan.allocatedMeat + releasedMeat;
  state.recordSurplusAudit(senderId, surplusMeat, new Map(), message.time);
  return {
    reply: [
      `Buy order set up: ${orderPlan.quantity.toLocaleString()} x ${orderPlan.item.name} at ${orderPlan.price.toLocaleString()} meat each (${orderPlan.allocatedMeat.toLocaleString()} meat allocated).`,
      ...(surplusMeat > 0
        ? [
            `Added ${surplusMeat.toLocaleString()} meat to surplus${releasedMeat > 0 ? `, including ${releasedMeat.toLocaleString()} meat released from your previous order` : ""}.`,
          ]
        : []),
      await formatSurplusBalance(state, senderId),
    ].join("\n"),
  };
}

function formatRejectedKmail(message: Kmail, reason: string): string {
  const attachedItems = [...message.items].map(
    ([item, quantity]) => `${quantity.toLocaleString()} x ${item.name}`,
  );
  return [
    `Rejected incoming kmail #${message.id} from ${message.who.name} (player ${message.who.id}).`,
    `Reason: ${reason}`,
    `Attached meat: ${message.meat.toLocaleString()}`,
    `Attached items: ${attachedItems.length > 0 ? attachedItems.join(", ") : "none"}`,
    "Quoted message:",
    quoteMessage(message.msg),
  ].join("\n");
}

async function formatSurplusBalance(
  state: TraderState,
  playerId: number,
): Promise<string> {
  const player = state.getPlayer(playerId);
  const items = await Promise.all(
    [...player.surplusItems].map(async ([itemId, quantity]) => {
      const item = await gameData.findItemById(itemId);
      return `${quantity.toLocaleString()} x ${item?.name ?? `Item #${itemId}`}`;
    }),
  );
  return `Current surplus: ${player.surplusMeat.toLocaleString()} meat; ${items.length > 0 ? items.join(", ") : "no surplus items"}.`;
}

async function parseBuyOrder(text: string): Promise<
  | {
      ok: true;
      item: NonNullable<Awaited<ReturnType<typeof gameData.findItemByName>>>;
      price: number;
    }
  | { ok: false; reason: string }
> {
  const trimmed = text.trim();
  const atCount = [...trimmed].filter((character) => character === "@").length;
  if (atCount !== 1) {
    return {
      ok: false,
      reason:
        "I can only handle one order per kmail- I see too many @ signs here. Use the format `[item name or item id] @ [price]`",
    };
  }

  const match = /^([^@]+?)\s*@\s*((?:\d{1,3}(?:,\d{3})+)|\d+)$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      reason: "Use the format `[item name or item id] @ [price]`.",
    };
  }

  const itemNameMatch = match[1];
  const priceMatch = match[2];
  if (itemNameMatch === undefined || priceMatch === undefined) {
    return {
      ok: false,
      reason: "Use the format `[item name or item id] @ [price]`.",
    };
  }
  const itemName = itemNameMatch.trim();
  const price = Number(priceMatch.replace(/,/g, ""));
  if (!itemName || !Number.isSafeInteger(price) || price <= 0) {
    return {
      ok: false,
      reason: "The item name and a positive whole-number price are required.",
    };
  }
  if (price < MIN_BUY_ORDER_PRICE || price > MAX_BUY_ORDER_PRICE) {
    return {
      ok: false,
      reason: `The price must be between ${MIN_BUY_ORDER_PRICE.toLocaleString()} and ${MAX_BUY_ORDER_PRICE.toLocaleString()} meat per item.`,
    };
  }

  let item = await gameData.findItemByName(itemName);
  if (!item && /^\d+$/.test(itemName)) {
    const itemId = Number(itemName);
    if (Number.isSafeInteger(itemId) && itemId > 0) {
      item = await gameData.findItemById(itemId);
    }
  }
  if (!item) {
    return {
      ok: false,
      reason: `I couldn't find an item named or numbered "${itemName}".`,
    };
  }
  if (isGiftPackage(item.id)) {
    return {
      ok: false,
      reason: "Gift packages cannot be used as buy-order items.",
    };
  }
  if (!item.tradeable && !item.gift) {
    return {
      ok: false,
      reason: `${item.name} is not tradeable and is not marked as a gift item, so it cannot be used for a buy order.`,
    };
  }
  return { ok: true, item, price };
}

function validateFulfillments(
  senderId: number,
  receivedMeat: number,
  fulfillments: Fulfillment[],
  state: TraderState,
): void {
  const sender = state.getPlayer(senderId);
  let senderProceeds = receivedMeat;
  const buyerSpending = new Map<
    number,
    {
      meat: number;
      surplusMeat: number;
      saleProceeds: number;
      items: Map<number, number>;
    }
  >();

  for (const { buyerId, itemId, quantity, price } of fulfillments) {
    const totalPrice = quantity * price;
    if (
      !Number.isSafeInteger(totalPrice) ||
      senderProceeds > Number.MAX_SAFE_INTEGER - totalPrice
    ) {
      throw new RangeError("Incoming trade proceeds exceed safe limits");
    }
    senderProceeds += totalPrice;

    let spending = buyerSpending.get(buyerId);
    if (!spending) {
      const buyer = state.getPlayer(buyerId);
      spending = {
        meat: buyer.meat,
        surplusMeat: buyer.surplusMeat,
        saleProceeds: buyer.transactions.reduce(
          (total, transaction) =>
            transaction.type === "sold"
              ? total + transaction.remainingMeat
              : total,
          0,
        ),
        items: new Map(),
      };
      buyerSpending.set(buyerId, spending);
    }
    if (
      spending.meat < totalPrice ||
      spending.surplusMeat + spending.saleProceeds < totalPrice
    ) {
      throw new RangeError(
        `Player ${buyerId} does not have enough accounted meat to fulfill the order`,
      );
    }
    const buyerItems = state.getPlayer(buyerId).items.get(itemId) ?? 0;
    if (
      quantity >
      Number.MAX_SAFE_INTEGER - buyerItems - (spending.items.get(itemId) ?? 0)
    ) {
      throw new RangeError(`Purchase quantity for item ${itemId} is too large`);
    }
    const spentSurplus = Math.min(spending.surplusMeat, totalPrice);
    spending.surplusMeat -= spentSurplus;
    spending.saleProceeds -= totalPrice - spentSurplus;
    spending.meat -= totalPrice;
    spending.items.set(itemId, (spending.items.get(itemId) ?? 0) + quantity);
  }

  if (senderProceeds > Number.MAX_SAFE_INTEGER - sender.meat) {
    throw new RangeError("Incoming trade proceeds exceed safe limits");
  }
}
