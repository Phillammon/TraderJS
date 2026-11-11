import { gameData, type Client } from "kol.js";
import { config } from "../config.js";
import { relevantItemsAndEffects } from "../gameconstants.js";
import { getActiveBuyOrdersForItem, getOrderQuantity } from "../orders.js";
import { quoteMessage } from "./operator.js";
import { cancelOrderForPlayer } from "./cancelorder.js";
import { parseChatCommand } from "./chatcommands.js";
import { getCommandAccountId, getCurrentMeat } from "./commandaccount.js";
import { findItemByName } from "./itemutils.js";
import { sendWithdrawal } from "./withdrawalsupport.js";
import {
  MAX_BUY_ORDER_PRICE,
  MIN_BUY_ORDER_PRICE,
  PROMOTIONAL_ACCOUNT_ID,
  type BuyOrder,
  type PlayerState,
  type TraderState,
} from "../state.js";
import type { Task } from "../types.js";

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
      const result = await processIncomingKmail(client, message, state);
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

async function processIncomingKmail(
  client: Client,
  message: Kmail,
  state: TraderState,
): Promise<KmailProcessingResult> {
  const senderId = message.who.id;
  const receivedItems = new Map(
    [...message.items]
      .filter(([item]) => !isGiftPackage(item.id))
      .map(([item, quantity]) => [item.id, quantity]),
  );
  const receivedMeat = message.meat;
  const isAssetless = receivedMeat === 0 && receivedItems.size === 0;
  if (Number.isNaN(message.time.getTime())) {
    const reason = "The kmail had an invalid timestamp.";
    state.recordSurplus(senderId, receivedMeat, receivedItems, new Date());
    return {
      reply: `I couldn't process this kmail because it had an invalid timestamp. All attached meat and items have been added to surplus. ${await formatSurplusBalance(state, senderId)}`,
      rejectionReason: reason,
    };
  }
  const cancelMatch = /^cancel(?:\s+(.+))?$/i.exec(message.msg.trim());
  if (cancelMatch) {
    const selector = cancelMatch[1]?.trim();
    if (!selector) {
      const reason = "The cancel command did not include an item name or ID.";
      state.recordSurplus(senderId, receivedMeat, receivedItems, message.time);
      return {
        reply: `To cancel an order, send "cancel [item name or item ID]" without attaching meat or items. ${receivedMeat > 0 || receivedItems.size > 0 ? `All attached resources were added to surplus. ${await formatSurplusBalance(state, senderId)}` : ""}`,
        rejectionReason: reason,
      };
    }
    if (receivedMeat > 0 || receivedItems.size > 0) {
      const reason =
        "A cancel command must not include meat or items; all attached resources were credited to sender surplus.";
      state.recordSurplus(senderId, receivedMeat, receivedItems, message.time);
      return {
        reply: `I can't process a cancel command that includes assets. All attached meat and items were added to surplus. ${await formatSurplusBalance(state, senderId)}`,
        rejectionReason: reason,
      };
    }
    const accountId = getCommandAccountId(senderId);
    const result = await cancelOrderForPlayer(state, accountId, selector);
    return {
      reply: result.message,
      ...(result.rejectionReason
        ? { rejectionReason: result.rejectionReason }
        : {}),
    };
  }
  if (isAssetless) {
    const command = parseChatCommand(message.msg);
    if (command) {
      state.enqueueChatRequest(command, senderId);
      return {};
    }
  }
  if (senderId === config.OPERATOR_ID && message.msg.includes("@")) {
    const attachedAssets = receivedMeat > 0 || receivedItems.size > 0;
    if (attachedAssets) {
      state.recordSurplus(senderId, receivedMeat, receivedItems, message.time);
    }

    const parsedOrder = await parseBuyOrder(message.msg).catch(
      (error: unknown) => ({
        ok: false as const,
        reason: `Could not parse the order note: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    if (!parsedOrder.ok) {
      return {
        reply: [
          `I couldn't create a bot-funded buy order: ${parsedOrder.reason}`,
          ...(attachedAssets
            ? [
                `Any attached assets were added to your surplus. ${await formatSurplusBalance(state, senderId)}`,
              ]
            : []),
        ].join(" "),
        rejectionReason: parsedOrder.reason,
      };
    }

    const totalMeat = await getCurrentMeat(client);
    const availableMeat = state.syncPromotionalAccount(totalMeat);
    const previousOrderMeat =
      state.getPlayer(PROMOTIONAL_ACCOUNT_ID).orders.get(parsedOrder.item.id)
        ?.meat ?? 0;
    const replacementAvailable = availableMeat + previousOrderMeat;
    const quantity =
      parsedOrder.quantity ??
      Math.floor(replacementAvailable / parsedOrder.price);
    const requiredMeat = quantity * parsedOrder.price;
    if (
      quantity <= 0 ||
      !Number.isSafeInteger(requiredMeat) ||
      requiredMeat > replacementAvailable
    ) {
      const reason = `The bot has ${replacementAvailable.toLocaleString()} meat available for this order, including its current allocation, which is not enough to fund ${parsedOrder.quantity ? `${parsedOrder.quantity.toLocaleString()} item(s)` : "one item"} at ${parsedOrder.price.toLocaleString()} meat each.`;
      return {
        reply: [
          `I couldn't create a bot-funded buy order: ${reason}`,
          ...(attachedAssets
            ? [
                `Any attached assets were added to your surplus. ${await formatSurplusBalance(state, senderId)}`,
              ]
            : []),
        ].join(" "),
        rejectionReason: reason,
      };
    }
    const order = state.createPromotionalBuyOrder(
      totalMeat,
      parsedOrder.item.id,
      parsedOrder.price,
      parsedOrder.quantity,
      message.time,
    );
    const remainingPromotionalMeat = state.getPlayer(
      PROMOTIONAL_ACCOUNT_ID,
    ).surplusMeat;
    return {
      reply: [
        `Bot-funded buy order set up: ${order.quantity.toLocaleString()} x ${parsedOrder.item.name} at ${parsedOrder.price.toLocaleString()} meat each (${order.allocatedMeat.toLocaleString()} meat allocated from bot-owned funds).`,
        `${remainingPromotionalMeat.toLocaleString()} bot-owned meat remains unallocated.`,
        ...(attachedAssets
          ? [
              `Your attached assets were credited to your surplus. ${await formatSurplusBalance(state, senderId)}`,
            ]
          : []),
      ].join(" "),
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
  if (
    receivedMeat === 0 &&
    realItems.length === 0 &&
    !message.msg.includes("@")
  ) {
    state.recordSurplus(senderId, receivedMeat, receivedItems, message.time);
    return {
      reply: [
        "I couldn't understand what you wanted because this kmail contained no meat or items.",
        "To create a buy order, send meat with a note in the format `[optional quantity] x [item name or item id] @ [price per item]` (100 to 1,000,000,000 meat per item).",
        "To fulfil a buy order, send the item(s) you want to sell.",
        'Message me "help" for commands and more information.',
      ].join("\n"),
      rejectionReason: "The kmail contained no assets.",
    };
  }

  const parsedOrder =
    receivedMeat > 0 || (realItems.length === 0 && message.msg.includes("@"))
      ? await parseBuyOrder(message.msg).catch((error: unknown) => ({
          ok: false as const,
          reason: `Could not parse the order note: ${error instanceof Error ? error.message : String(error)}`,
        }))
      : undefined;
  const existingPlayer = state.getPlayer(senderId);
  const previousOrderMeat = parsedOrder?.ok
    ? (existingPlayer.orders.get(parsedOrder.item.id)?.meat ?? 0)
    : 0;
  const availableOrderMeat = parsedOrder?.ok
    ? existingPlayer.surplusMeat + receivedMeat + previousOrderMeat
    : 0;
  if (parsedOrder?.ok && !Number.isSafeInteger(availableOrderMeat)) {
    throw new RangeError("Available buy order surplus exceeds safe limits");
  }
  const requestedMeat =
    parsedOrder?.ok && parsedOrder.quantity !== undefined
      ? parsedOrder.quantity * parsedOrder.price
      : undefined;
  const orderPlan =
    parsedOrder?.ok &&
    (requestedMeat ?? parsedOrder.price) <= availableOrderMeat
      ? {
          item: parsedOrder.item,
          price: parsedOrder.price,
          quantity:
            parsedOrder.quantity ??
            Math.floor(availableOrderMeat / parsedOrder.price),
          allocatedMeat:
            requestedMeat ??
            Math.floor(availableOrderMeat / parsedOrder.price) *
              parsedOrder.price,
        }
      : undefined;
  if (orderPlan) {
    const postOrderSurplus = availableOrderMeat - orderPlan.allocatedMeat;
    if (!Number.isSafeInteger(postOrderSurplus)) {
      throw new RangeError("Buy order surplus exceeds safe limits");
    }
  }
  if (
    receivedItems.size > 0 &&
    state.players.get(PROMOTIONAL_ACCOUNT_ID)?.orders.size
  ) {
    state.syncPromotionalAccount(await getCurrentMeat(client));
  }
  const fulfillments: Fulfillment[] = [];
  for (const [itemId, quantity] of receivedItems) {
    if (isGiftPackage(itemId)) {
      continue;
    }
    let remainingQuantity = quantity;
    const orders = getActiveBuyOrdersForItem(state.players, itemId);

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
  const saleProceeds = fulfillments
    .filter(({ buyerId }) => buyerId !== senderId)
    .reduce(
      (total, { quantity, price }) => total + quantity * price,
      0,
    );
  if (!Number.isSafeInteger(saleProceeds)) {
    throw new RangeError("Fulfillment proceeds exceed safe limits");
  }
  const selfPurchasedItems = new Map<number, number>();
  for (const fulfillment of fulfillments) {
    if (fulfillment.buyerId === senderId) {
      selfPurchasedItems.set(
        fulfillment.itemId,
        (selfPurchasedItems.get(fulfillment.itemId) ?? 0) +
          fulfillment.quantity,
      );
    }
  }
  const sellerItems = new Map(
    [...receivedItems].map(([itemId, quantity]) => [
      itemId,
      quantity - (selfPurchasedItems.get(itemId) ?? 0),
    ]),
  );
  for (const [itemId, quantity] of sellerItems) {
    if (quantity <= 0) {
      sellerItems.delete(itemId);
    }
  }
  state.recordSurplus(senderId, 0, sellerItems, message.time, false);
  const surplusItems = new Map(receivedItems);
  for (const [itemId, quantity] of selfPurchasedItems) {
    surplusItems.set(itemId, (surplusItems.get(itemId) ?? 0) - quantity);
  }

  for (const fulfillment of fulfillments) {
    const { buyerId, itemId, quantity, price, player, order } = fulfillment;
    const totalPrice = quantity * price;
    state.recordPurchase(buyerId, itemId, quantity, price, message.time, {
      recordAudit: true,
      reservedMeat: totalPrice,
      selfDealing: buyerId === senderId,
    });
    if (buyerId !== senderId) {
      state.recordSale(senderId, itemId, quantity, price, message.time, false);
      state.recordTradeAudit(
        senderId,
        buyerId,
        itemId,
        quantity,
        price,
        message.time,
      );
      surplusItems.set(itemId, (surplusItems.get(itemId) ?? 0) - quantity);
    }
    order.meat -= totalPrice;
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
  const returnableSurplusItems = new Map(
    [...surplusItems].filter(([, quantity]) => quantity > 0),
  );
  const seller =
    saleProceeds > 0 || returnableSurplusItems.size > 0
      ? await client.players.fetch(senderId)
      : undefined;
  const canSendProceeds =
    !!seller &&
    !seller.inHardcore &&
    !seller.inRonin &&
    seller.path !== "Legacy of Loathing";
  if (
    canSendProceeds &&
    (saleProceeds > 0 || returnableSurplusItems.size > 0)
  ) {
    await sendWithdrawal(
      client,
      senderId,
      { meat: saleProceeds, items: returnableSurplusItems },
      state.getPlayer(senderId),
      state,
      true,
    );
  }

  if (receivedMeat <= 0 && parsedOrder === undefined) {
    const fulfilledLines = await Promise.all(
      fulfillments.map(async ({ itemId, quantity, price }) => {
        const item = await gameData.findItemById(itemId);
        return `- Matched ${quantity.toLocaleString()} x ${item?.name ?? `Item #${itemId}`} at ${price.toLocaleString()} meat each.`;
      }),
    );
    const surplusLines = await Promise.all(
      [...surplusItems].map(async ([itemId, quantity]) => {
        const item = await gameData.findItemById(itemId);
        return `- ${quantity.toLocaleString()} x ${item?.name ?? `Item #${itemId}`} ${canSendProceeds ? "returned to you" : "added to surplus"}.`;
      }),
    );
    return {
      reply: [
        "I received your items.",
        "",
        "Fulfilled buy orders:",
        fulfilledLines.length > 0 ? fulfilledLines.join("\n") : "- None",
        "",
        canSendProceeds
          ? "Surplus items returned:"
          : "Items added to surplus:",
        surplusLines.length > 0 ? surplusLines.join("\n") : "- None",
        ...(saleProceeds > 0
          ? [
              canSendProceeds
                ? `Sent ${saleProceeds.toLocaleString()} meat directly from fulfilled buy orders.`
                : `${saleProceeds.toLocaleString()} meat from fulfilled buy orders is held in your balance because your account cannot currently receive it.`,
            ]
          : []),
        ...(returnableSurplusItems.size > 0 && !canSendProceeds
          ? [
              "Your items remain stored because your account cannot currently receive them.",
            ]
          : []),
        "",
        await formatSurplusBalance(state, senderId),
      ].join("\n"),
    };
  }

  if (!parsedOrder) {
    throw new Error("Kmail with meat did not produce an order parse result");
  }
  if (!parsedOrder.ok) {
    state.recordSurplus(senderId, receivedMeat, new Map(), message.time, false);
    state.recordSurplusAudit(senderId, receivedMeat, new Map(), message.time);
    const receipt =
      receivedMeat > 0
        ? `I have added all ${receivedMeat.toLocaleString()} attached meat to your surplus balance.`
        : "Your existing surplus remains unchanged.";
    return {
      reply: `I couldn't create a buy order from your kmail: ${parsedOrder.reason} ${receipt} ${await formatSurplusBalance(state, senderId)}`,
      rejectionReason: parsedOrder.reason,
    };
  }

  const requiredMeat =
    parsedOrder.quantity === undefined
      ? parsedOrder.price
      : parsedOrder.quantity * parsedOrder.price;
  if (requiredMeat > availableOrderMeat) {
    state.recordSurplus(senderId, receivedMeat, new Map(), message.time, false);
    state.recordSurplusAudit(senderId, receivedMeat, new Map(), message.time);
    const rejectionReason = `The requested order requires ${requiredMeat.toLocaleString()} meat, but only ${availableOrderMeat.toLocaleString()} meat is available from your surplus and this kmail.`;
    const receipt =
      receivedMeat > 0
        ? `All ${receivedMeat.toLocaleString()} attached meat has been added to your surplus balance.`
        : "Your existing surplus remains unchanged.";
    return {
      reply: `I couldn't create a buy order for ${parsedOrder.item.name}: the requested order requires ${requiredMeat.toLocaleString()} meat, but only ${availableOrderMeat.toLocaleString()} meat is available from your surplus and this kmail. ${receipt} ${await formatSurplusBalance(state, senderId)}`,
      rejectionReason,
    };
  }

  if (!orderPlan) {
    throw new Error("Valid order text did not produce a valid buy order");
  }
  let releasedMeat: number;
  try {
    releasedMeat = state.createBuyOrderFromSurplus(
      senderId,
      orderPlan.item.id,
      orderPlan.allocatedMeat,
      orderPlan.price,
      message.time,
      receivedMeat,
    );
  } catch (error) {
    state.recordSurplus(senderId, receivedMeat, new Map(), message.time, false);
    state.recordSurplusAudit(senderId, receivedMeat, new Map(), message.time);
    throw error;
  }
  const surplusMeat = Math.max(
    0,
    receivedMeat - orderPlan.allocatedMeat + releasedMeat,
  );
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
      item: NonNullable<Awaited<ReturnType<typeof findItemByName>>>;
      price: number;
      quantity?: number;
    }
  | { ok: false; reason: string }
> {
  const trimmed = text.trim();
  const atCount = [...trimmed].filter((character) => character === "@").length;
  if (atCount !== 1) {
    return {
      ok: false,
      reason:
        "I can only handle one order per kmail- I see too many @ signs here. Use the format `[optional quantity] x [item name or item id] @ [price per item]`",
    };
  }

  const match =
    /^(?:(\d{1,3}(?:,\d{3})+|\d+)\s*[xX]\s*)?([^@]+?)\s*@\s*((?:\d{1,3}(?:,\d{3})+)|\d+)$/.exec(
      trimmed,
    );
  if (!match) {
    return {
      ok: false,
      reason:
        "Use the format `[optional quantity] x [item name or item id] @ [price per item]`.",
    };
  }

  const quantityMatch = match[1];
  const itemNameMatch = match[2];
  const priceMatch = match[3];
  if (itemNameMatch === undefined || priceMatch === undefined) {
    return {
      ok: false,
      reason:
        "Use the format `[optional quantity] x [item name or item id] @ [price per item]`.",
    };
  }
  const matchedItemName = itemNameMatch.trim();
  const itemName =
    matchedItemName || trimmed.slice(0, trimmed.indexOf("@")).trim();
  const price = Number(priceMatch.replace(/,/g, ""));
  const quantity =
    quantityMatch === undefined || !matchedItemName
      ? undefined
      : Number(quantityMatch.replace(/,/g, ""));
  if (!itemName || !Number.isSafeInteger(price) || price <= 0) {
    return {
      ok: false,
      reason: "The item name and a positive whole-number price are required.",
    };
  }
  if (
    quantity !== undefined &&
    (!Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !Number.isSafeInteger(quantity * price))
  ) {
    return {
      ok: false,
      reason:
        "The requested quantity must be a positive whole number and the total order value must be within safe limits.",
    };
  }
  if (price < MIN_BUY_ORDER_PRICE || price > MAX_BUY_ORDER_PRICE) {
    return {
      ok: false,
      reason: `The price must be between ${MIN_BUY_ORDER_PRICE.toLocaleString()} and ${MAX_BUY_ORDER_PRICE.toLocaleString()} meat per item.`,
    };
  }

  let item = await findItemByName(itemName);
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
  return {
    ok: true,
    item,
    price,
    ...(quantity === undefined ? {} : { quantity }),
  };
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
      items: Map<number, number>;
      reservedOrders: Map<BuyOrder, number>;
    }
  >();

  for (const { buyerId, itemId, quantity, price, order } of fulfillments) {
    const totalPrice = quantity * price;
    if (!Number.isSafeInteger(totalPrice)) {
      throw new RangeError("Incoming trade proceeds exceed safe limits");
    }
    if (buyerId !== senderId) {
      if (senderProceeds > Number.MAX_SAFE_INTEGER - totalPrice) {
        throw new RangeError("Incoming trade proceeds exceed safe limits");
      }
      senderProceeds += totalPrice;
    }

    let spending = buyerSpending.get(buyerId);
    if (!spending) {
      const buyer = state.getPlayer(buyerId);
      spending = {
        meat: buyer.meat,
        items: new Map(),
        reservedOrders: new Map(),
      };
      buyerSpending.set(buyerId, spending);
    }
    const orderSpent = spending.reservedOrders.get(order) ?? 0;
    if (spending.meat < totalPrice || order.meat - orderSpent < totalPrice) {
      throw new RangeError(
        `Player ${buyerId} does not have enough reserved order meat to fulfill the order`,
      );
    }
    const buyerItems = state.getPlayer(buyerId).items.get(itemId) ?? 0;
    if (
      quantity >
      Number.MAX_SAFE_INTEGER - buyerItems - (spending.items.get(itemId) ?? 0)
    ) {
      throw new RangeError(`Purchase quantity for item ${itemId} is too large`);
    }
    spending.meat -= totalPrice;
    spending.reservedOrders.set(order, orderSpent + totalPrice);
    spending.items.set(itemId, (spending.items.get(itemId) ?? 0) + quantity);
  }

  if (senderProceeds > Number.MAX_SAFE_INTEGER - sender.meat) {
    throw new RangeError("Incoming trade proceeds exceed safe limits");
  }
}
