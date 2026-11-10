import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config.js";
import { relevantItemsAndEffects } from "./gameconstants.js";
import { gameData, type Client } from "kol.js";
import type { Item } from "data-of-loathing";
import type {
  AuditTransaction,
  ChatCommand,
  PlayerState,
  TradeTransaction,
  TraderState,
} from "./state.js";
import {
  aggregateBuyOrders,
  getOrderQuantity,
  getReservedOrderMeat,
  getWithdrawableAssets,
} from "./orders.js";
import {
  OperatorNotificationsTask,
  queueUnrecognizedChatMessage,
} from "./operator.js";
import { DeleteProcessedKmailTask } from "./deleteprocessedkmailtask.js";
import { KmailRepliesTask } from "./replytask.js";
import { TraderTask } from "./tradertask.js";
import type { Task } from "./types.js";

const COMMANDS: readonly ChatCommand[] = [
  "help",
  "orders",
  "withdraw",
  "balance",
];

const OpenGiftPackages: Task = {
  name: "Open Gift Packages",
  done: async (client) =>
    (
      await Promise.all(
        relevantItemsAndEffects.PACKAGES.map(async (giftPackage) => {
          return (await client.inventory.get()).get(giftPackage) ?? 0;
        }),
      )
    ).every((quantity) => quantity === 0),
  execute: async (client) => {
    const packages = (
      await Promise.all(
        relevantItemsAndEffects.PACKAGES.map(
          async (giftPackage) =>
            [
              giftPackage,
              (await client.inventory.get()).get(giftPackage) ?? 0,
            ] as const,
        ),
      )
    )
      .filter(([, quantity]) => quantity > 0)
      .map(([giftPackage]) => giftPackage);

    for (const giftPackage of packages) {
      await client.fetchText("inv_use.php", {
        method: "GET",
        query: {
          which: 3,
          whichitem: giftPackage.id,
        },
      });
    }
    return true;
  },
};

const SpamOffChatEffects: Task = {
  name: "Spamming Off Chat Effects",
  done: async (client) =>
    (
      await Promise.all(
        relevantItemsAndEffects.ANNOYING_EFFECTS.map(async (effect) => {
          return (await client.effects.remainingEffectTurns(effect)) ?? 0;
        }),
      )
    ).every((turns) => turns === 0),
  execute: async (client) => {
    await client.chat.macro("/talkie Spamming off annoying chat effect");
    return true;
  },
};

const ChatBeacon: Task = {
  name: "Announce In Chat",
  done: async (_client, state) =>
    state.lastBeacon ===
    Math.floor(Date.now() / (1000 * config.TRADE_BEACON_DELAY)),
  execute: async (client, state) => {
    const activeOrders = aggregateBuyOrders(state.players);
    const items = [...activeOrders.entries()];
    let advertisement =
      "I can help you make buy orders- message me `help` to find out more!";
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
      advertisement = `I'm buying ${quantity.toLocaleString()} x ${await getItemName(itemId)} at ${highestPrice.toLocaleString()} meat each. Message me "orders" to find out what else I'm buying!`;
    }
    await client.chat.macro(`/trade ${advertisement}`);
    state.lastBeacon = Math.floor(
      Date.now() / (1000 * config.TRADE_BEACON_DELAY),
    );
    return true;
  },
};

export const HelpTask: Task = {
  name: "Help",
  done: async (_client, state) => state.helpQueue.length === 0,
  execute: async (client, state) => {
    const playerId = state.peekChatRequest("help");
    if (playerId === undefined) {
      return true;
    }

    await client.kmail.send(
      playerId,
      [
        "Hi! I'm TheTrader, your friendly neighbourhood buy order bot.",
        "",
        "Message one of these commands to me:",
        "- help: show these instructions",
        "- orders: list active buy orders",
        "- balance: show your active buy orders and what I'm holding for you",
        "- withdraw: return your available stored meat and items",
        "",
        "To create a buy order, send me meat with a one-line note:",
        "[item name or item id] @ [price]",
        "For example: seal-clubbing club @ 100",
        "Prices must be between 100 and 1,000,000,000 meat per item.",
        "A new order replaces your existing order for that item.",
        "",
        "To fulfil a buy order, send me the items you want to sell.",
      ].join("\n"),
    );
    state.completeChatRequest("help", playerId);
    return true;
  },
};

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
          return `- ${itemName} (ID ${itemId}): ${quantity.toLocaleString()} items at ${order.price.toLocaleString()} meat each (${order.meat.toLocaleString()} meat reserved)`;
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
          return `  - ${quantity.toLocaleString()} at ${price.toLocaleString()} meat each`;
        });
        const lowerQuantity = levels
          .slice(3)
          .reduce((total, [, quantity]) => total + quantity, 0);
        if (lowerQuantity > 0) {
          highestLevels.push(
            `  - And ${lowerQuantity.toLocaleString()} more at lower prices`,
          );
        }
        return `- ${itemName} (ID ${itemId})\n${highestLevels.join("\n")}`;
      }),
    );
    await client.kmail.send(
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

    await client.kmail.send(
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

export const WithdrawTask: Task = {
  name: "Withdraw",
  done: async (_client, state) => state.withdrawQueue.length === 0,
  execute: async (client, state) => {
    const playerId = state.peekChatRequest("withdraw");
    if (playerId === undefined) {
      return true;
    }

    const stored = state.getPlayer(playerId);
    const available = getWithdrawableAssets(stored);
    if (available.items.size === 0 && available.meat === 0) {
      await client.kmail.send(
        playerId,
        "I can't currently send you anything. Your stored items and meat are either empty or reserved for active buy orders.",
      );
      state.completeChatRequest("withdraw", playerId);
      state.save();
      return true;
    }

    const recipient = await client.players.fetch(playerId);
    if (!recipient) {
      await client.kmail.send(
        playerId,
        "I couldn't verify that your account can receive items right now, so I haven't sent your stored assets. Please try again later.",
      );
      state.completeChatRequest("withdraw", playerId);
      state.save();
      return true;
    }

    const usesGiftPackages =
      recipient.inHardcore ||
      recipient.inRonin ||
      recipient.path === "Legacy of Loathing";
    if (usesGiftPackages) {
      await client.kmail.send(
        playerId,
        "I can't send your stored assets while your account is in Hardcore, Ronin, or Legacy of Loathing. Please whisper `withdraw` again when you are no longer in that state.",
      );
      state.completeChatRequest("withdraw", playerId);
      state.save();
      return true;
    }

    await sendWithdrawal(client, playerId, available, stored, state);
    state.completeChatRequest("withdraw", playerId);
    state.save();
    return true;
  },
};

export const RegularWithdrawTask: Task = {
  name: "Regular Withdrawals",
  done: async (_client, state) =>
    state.lastWithdrawalInterval === getWithdrawalInterval(),
  execute: async (client, state) => {
    for (const [playerId, stored] of state.players) {
      const available = getWithdrawableAssets(stored);
      if (available.items.size === 0 && available.meat === 0) {
        continue;
      }

      const recipient = await client.players.fetch(playerId);
      if (!recipient) {
        throw new Error(
          `Could not verify player ${playerId} for regular withdrawal`,
        );
      }
      if (
        recipient.inHardcore ||
        recipient.inRonin ||
        recipient.path === "Legacy of Loathing"
      ) {
        continue;
      }

      await sendWithdrawal(client, playerId, available, stored, state);
      state.save();
    }

    state.lastWithdrawalInterval = getWithdrawalInterval();
    state.save();
    return true;
  },
};

export const PollChatTask: Task = {
  name: "Poll Chat",
  done: async (_client, state) =>
    Date.now() - state.lastChatPoll < config.CHAT_POLL_DELAY * 1000,
  execute: async (client, state) => {
    const messages = await client.chat.fetch();
    for (const message of messages) {
      if (message.type !== "private") {
        continue;
      }
      const requestedCommand = message.msg.trim().toLowerCase();
      const command = COMMANDS.find(
        (supportedCommand) => supportedCommand === requestedCommand,
      );
      if (command) {
        state.enqueueChatRequest(command, message.who.id);
      } else {
        queueUnrecognizedChatMessage(state, message);
        await client.chat.send(
          message.who.id,
          'I don\'t recognize that command. Whisper "help" to see what I can do.',
        );
      }
    }
    state.lastChatPoll = Date.now();
    state.save();
    return true;
  },
};

export const LedgerLogTask: Task = {
  name: "Write Ledger Log",
  done: async (_client, state) =>
    state.lastLedgerLogInterval === getLedgerLogInterval(),
  execute: async (_client, state) => {
    const now = new Date();
    const interval = getLedgerLogInterval();
    const filename = `ledger-${interval}-${now
      .toISOString()
      .replace(/[:.]/g, "-")}.log`;
    const filepath = path.join(config.LEDGER_LOG_DIR, filename);
    const transactions = [...state.pendingAuditTransactions];
    const humanReadableLog = await formatLedgerLog(state, transactions, now);
    const stateSnapshot = createRollbackSnapshot(state, interval);
    const logContents = [
      humanReadableLog,
      "",
      "=== JSON STATE SNAPSHOT FOR ROLLBACK ===",
      JSON.stringify(stateSnapshot, null, 2),
      "",
    ].join("\n");

    fs.mkdirSync(config.LEDGER_LOG_DIR, { recursive: true });
    fs.writeFileSync(filepath, logContents, "utf8");

    state.pendingAuditTransactions.length = 0;
    state.lastLedgerLogInterval = interval;
    state.save();
    console.log(`Wrote ledger log to ${filepath}`);
    return true;
  },
};

export const TraderTasks: Task[] = [
  OpenGiftPackages,
  HelpTask,
  OrdersTask,
  BalanceTask,
  WithdrawTask,
  RegularWithdrawTask,
  KmailRepliesTask,
  TraderTask,
  OperatorNotificationsTask,
  DeleteProcessedKmailTask,
  SpamOffChatEffects,
  //ChatBeacon,
  PollChatTask,
  LedgerLogTask,
];

async function formatLedgerLog(
  state: TraderState,
  transactions: AuditTransaction[],
  generatedAt: Date,
): Promise<string> {
  const lines = [
    "TraderJS ledger report",
    `Generated: ${generatedAt.toISOString()}`,
    `Interval: ${config.LEDGER_LOG_DELAY} seconds`,
    "",
    "Transactions since previous log:",
  ];

  if (transactions.length === 0) {
    lines.push("- None");
  } else {
    for (const transaction of transactions) {
      lines.push(await formatAuditTransaction(transaction));
    }
  }

  lines.push("", "Current ledgers:");
  if (state.players.size === 0) {
    lines.push("- No players have ledger entries.");
  }
  for (const [playerId, player] of state.players) {
    lines.push(
      "",
      `Player ${playerId}`,
      `  Meat balance: ${player.meat.toLocaleString()}`,
      `  Non-transactional surplus meat: ${player.surplusMeat.toLocaleString()}`,
      "  Items:",
    );
    if (player.items.size === 0) {
      lines.push("    - None");
    } else {
      for (const [itemId, quantity] of player.items) {
        lines.push(
          `    - ${quantity.toLocaleString()} x ${await getItemName(itemId)} (item ${itemId})`,
        );
      }
    }

    lines.push("  Non-transactional surplus items:");
    if (player.surplusItems.size === 0) {
      lines.push("    - None");
    } else {
      for (const [itemId, quantity] of player.surplusItems) {
        lines.push(
          `    - ${quantity.toLocaleString()} x ${await getItemName(itemId)} (item ${itemId})`,
        );
      }
    }

    lines.push("  Active buy orders:");
    if (player.orders.size === 0) {
      lines.push("    - None");
    } else {
      for (const [itemId, order] of player.orders) {
        lines.push(
          `    - ${order.meat.toLocaleString()} meat reserved for ${await getItemName(itemId)} (item ${itemId}) at ${order.price.toLocaleString()} meat each`,
        );
      }
    }
  }

  return lines.join("\n");
}

async function formatAuditTransaction(
  transaction: AuditTransaction,
): Promise<string> {
  if (transaction.type === "trade") {
    const itemName = await getItemName(transaction.itemId);
    return `- ${transaction.timestamp} | Player ${transaction.sellerId} sold ${transaction.quantity.toLocaleString()} x ${itemName} to Player ${transaction.buyerId} at ${transaction.price.toLocaleString()} meat each (${(transaction.quantity * transaction.price).toLocaleString()} meat)`;
  }

  if (
    transaction.type === "withdrawn" ||
    transaction.type === "sent" ||
    transaction.type === "surplus"
  ) {
    const items = await Promise.all(
      Object.entries(transaction.items).map(async ([itemId, quantity]) => {
        return `${quantity.toLocaleString()} x ${await getItemName(Number(itemId))}`;
      }),
    );
    const assets = [
      ...(transaction.meat > 0
        ? [`${transaction.meat.toLocaleString()} meat`]
        : []),
      ...items,
    ];
    const description =
      transaction.type === "sent"
        ? `Sent to Player ${transaction.playerId}`
        : transaction.type === "surplus"
          ? `Surplus received for Player ${transaction.playerId}`
          : `Player ${transaction.playerId} withdrew`;
    return `- ${transaction.timestamp} | ${description}: ${assets.join(", ") || "no assets"}`;
  }

  const itemName = await getItemName(transaction.itemId);
  if (transaction.type === "bought") {
    return `- ${transaction.timestamp} | Player ${transaction.playerId} bought ${transaction.quantity.toLocaleString()} x ${itemName} (item ${transaction.itemId}) at ${transaction.price.toLocaleString()} meat each; total ${(transaction.quantity * transaction.price).toLocaleString()} meat`;
  }
  return `- ${transaction.timestamp} | Player ${transaction.playerId} sold ${transaction.quantity.toLocaleString()} x ${itemName} (item ${transaction.itemId}) at ${transaction.price.toLocaleString()} meat each; proceeds ${transaction.meat.toLocaleString()} meat`;
}

function createRollbackSnapshot(state: TraderState, interval: number): object {
  return {
    players: Object.fromEntries(
      [...state.players].map(([playerId, player]) => [
        playerId,
        {
          orders: Object.fromEntries(player.orders),
          meat: player.meat,
          items: Object.fromEntries(player.items),
          transactions: player.transactions,
          surplusMeat: player.surplusMeat,
          surplusItems: Object.fromEntries(player.surplusItems),
        },
      ]),
    ),
    lastBeacon: state.lastBeacon,
    lastChatPoll: state.lastChatPoll,
    lastWithdrawalInterval: state.lastWithdrawalInterval,
    lastLedgerLogInterval: interval,
    pendingAuditTransactions: [],
    processedKmailIds: [...state.processedKmailIds],
    pendingKmailReplies: Object.fromEntries(state.pendingKmailReplies),
    pendingOperatorNotifications: Object.fromEntries(
      state.pendingOperatorNotifications,
    ),
    chatQueues: {
      help: state.helpQueue,
      orders: state.ordersQueue,
      withdraw: state.withdrawQueue,
      balance: state.balanceQueue,
    },
  };
}

async function getItemName(itemId: number): Promise<string> {
  const item = await gameData.findItemById(itemId);
  return item ? item.name : `Item #${itemId}`;
}

async function resolveItems(
  itemQuantities: Map<number, number>,
): Promise<Map<Item, number>> {
  const items = new Map<Item, number>();
  for (const [itemId, quantity] of itemQuantities) {
    const item = await gameData.findItemById(itemId);
    if (!item) {
      throw new Error(`Could not find item ${itemId} for withdrawal`);
    }
    items.set(item, quantity);
  }
  return items;
}

async function sendWithdrawal(
  client: Client,
  playerId: number,
  available: { meat: number; items: Map<number, number> },
  stored: PlayerState,
  state: TraderState,
): Promise<void> {
  const itemBatches = chunkItems([...available.items], 10);
  if (itemBatches.length === 0) {
    itemBatches.push([]);
  }

  for (const [index, itemBatch] of itemBatches.entries()) {
    const batchItems = new Map(itemBatch);
    const batchMeat = index === 0 ? available.meat : 0;
    const report = await prepareWithdrawalReport(stored, {
      meat: batchMeat,
      items: batchItems,
    });
    const items = await resolveItems(batchItems);
    const message =
      itemBatches.length > 1
        ? `Part ${index + 1} of ${itemBatches.length}\n\n${report.message}`
        : report.message;

    await client.kmail.send(playerId, message, {
      items,
      ...(batchMeat > 0 ? { meat: batchMeat } : {}),
    });
    state.recordSent(playerId, batchMeat, batchItems, {
      meat: report.surplusMeat,
      items: report.surplusItems,
    });
    applyTransactionWithdrawals(stored.transactions, report.allocations);
    state.save();
  }
}

function chunkItems(
  items: [number, number][],
  batchSize: number,
): [number, number][][] {
  const batches: [number, number][][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

type TransactionAllocation = {
  transaction: TradeTransaction;
  quantity?: number;
  meat?: number;
};

async function prepareWithdrawalReport(
  stored: PlayerState,
  available: { meat: number; items: Map<number, number> },
): Promise<{
  message: string;
  allocations: TransactionAllocation[];
  surplusMeat: number;
  surplusItems: Map<number, number>;
}> {
  const boughtLines: string[] = [];
  const soldLines: string[] = [];
  const surplusLines: string[] = [];
  const allocations: TransactionAllocation[] = [];
  const surplusItems = new Map<number, number>();
  const itemQuantities = new Map(available.items);

  for (const transaction of stored.transactions) {
    if (transaction.type !== "bought") {
      continue;
    }

    const remaining = itemQuantities.get(transaction.itemId) ?? 0;
    const quantity = Math.min(remaining, transaction.remainingQuantity);
    if (quantity <= 0) {
      continue;
    }

    const itemName = await getItemName(transaction.itemId);
    boughtLines.push(
      `- ${formatTimestamp(transaction.timestamp)}: ${quantity.toLocaleString()} x ${itemName} at ${transaction.price.toLocaleString()} meat each (${(quantity * transaction.price).toLocaleString()} meat total)`,
    );
    allocations.push({ transaction, quantity });
    itemQuantities.set(transaction.itemId, remaining - quantity);
  }

  for (const [itemId, quantity] of itemQuantities) {
    if (quantity <= 0) {
      continue;
    }
    const surplusQuantity = stored.surplusItems.get(itemId) ?? 0;
    if (quantity > surplusQuantity) {
      throw new Error(
        `${quantity} withdrawable item(s) for item ${itemId} exceed recorded surplus`,
      );
    }
    surplusItems.set(itemId, quantity);
    surplusLines.push(
      `- ${quantity.toLocaleString()} x ${await getItemName(itemId)} (not associated with a trade)`,
    );
  }

  let remainingMeat = available.meat;
  for (const transaction of stored.transactions) {
    if (transaction.type !== "sold" || remainingMeat <= 0) {
      continue;
    }

    const meat = Math.min(remainingMeat, transaction.remainingMeat);
    if (meat <= 0) {
      continue;
    }

    const itemName = await getItemName(transaction.itemId);
    soldLines.push(
      `- ${formatTimestamp(transaction.timestamp)}: sold ${transaction.quantity.toLocaleString()} x ${itemName} at ${transaction.price.toLocaleString()} meat each (${transaction.meat.toLocaleString()} meat proceeds; ${meat.toLocaleString()} included in this withdrawal)`,
    );
    allocations.push({ transaction, meat });
    remainingMeat -= meat;
  }
  const surplusMeat = remainingMeat;
  if (surplusMeat > stored.surplusMeat) {
    throw new Error(
      `${surplusMeat} withdrawable meat exceeds recorded surplus`,
    );
  }

  return {
    message: [
      "Withdrawal transaction details:",
      "",
      "Bought (items):",
      boughtLines.length ? boughtLines.join("\n") : "- None",
      "",
      "Sold (meat):",
      soldLines.length ? soldLines.join("\n") : "- None",
      "",
      "Surplus (not associated with a trade):",
      [
        ...(surplusMeat > 0 ? [`- ${surplusMeat.toLocaleString()} meat`] : []),
        ...surplusLines,
      ].join("\n") || "- None",
    ].join("\n"),
    allocations,
    surplusMeat,
    surplusItems,
  };
}

function applyTransactionWithdrawals(
  transactions: TradeTransaction[],
  allocations: TransactionAllocation[],
): void {
  for (const allocation of allocations) {
    if (allocation.transaction.type === "bought") {
      allocation.transaction.remainingQuantity -= allocation.quantity ?? 0;
    } else {
      allocation.transaction.remainingMeat -= allocation.meat ?? 0;
    }
  }
  for (let index = transactions.length - 1; index >= 0; index--) {
    const transaction = transactions[index];
    if (transaction?.type === "bought" && transaction.remainingQuantity === 0) {
      transactions.splice(index, 1);
    } else if (
      transaction?.type === "sold" &&
      transaction.remainingMeat === 0
    ) {
      transactions.splice(index, 1);
    }
  }
}

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toISOString();
}

function getWithdrawalInterval(): number {
  return Math.floor(Date.now() / (1000 * config.WITHDRAWAL_DELAY));
}

function getLedgerLogInterval(): number {
  return Math.floor(Date.now() / (1000 * config.LEDGER_LOG_DELAY));
}
