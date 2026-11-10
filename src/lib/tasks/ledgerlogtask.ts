import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { getItemName } from "./itemutils.js";
import {
  PROMOTIONAL_ACCOUNT_ID,
  type AuditTransaction,
  type TraderState,
} from "../state.js";
import type { Task } from "../types.js";

function getLedgerLogInterval(): number {
  return Math.floor(Date.now() / (1000 * config.LEDGER_LOG_DELAY));
}

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
      `${getAccountName(playerId)}`,
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
    return `- ${transaction.timestamp} | ${getAccountName(transaction.sellerId)} sold ${transaction.quantity.toLocaleString()} x ${itemName} to ${getAccountName(transaction.buyerId)} at ${transaction.price.toLocaleString()} meat each (${(transaction.quantity * transaction.price).toLocaleString()} meat)`;
  }

  if (
    transaction.type === "withdrawn" ||
    transaction.type === "sent" ||
    transaction.type === "surplus" ||
    transaction.type === "unallocated"
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
      transaction.type === "unallocated"
        ? "Unallocated from promotional account"
        : transaction.type === "sent"
          ? `Sent to Player ${transaction.playerId}`
          : transaction.type === "surplus"
            ? `Surplus received for ${getAccountName(transaction.playerId)}`
            : `${getAccountName(transaction.playerId)} withdrew`;
    return `- ${transaction.timestamp} | ${description}: ${assets.join(", ") || "no assets"}`;
  }

  const itemName = await getItemName(transaction.itemId);
  if (transaction.type === "orderCancelled") {
    return `- ${transaction.timestamp} | ${getAccountName(transaction.playerId)} cancelled their buy order for ${itemName} (item ${transaction.itemId}); ${transaction.meat.toLocaleString()} reserved meat released to surplus`;
  }
  if (transaction.type === "bought") {
    return `- ${transaction.timestamp} | ${getAccountName(transaction.playerId)} bought ${transaction.quantity.toLocaleString()} x ${itemName} (item ${transaction.itemId}) at ${transaction.price.toLocaleString()} meat each; total ${(transaction.quantity * transaction.price).toLocaleString()} meat`;
  }
  return `- ${transaction.timestamp} | ${getAccountName(transaction.playerId)} sold ${transaction.quantity.toLocaleString()} x ${itemName} (item ${transaction.itemId}) at ${transaction.price.toLocaleString()} meat each; proceeds ${transaction.meat.toLocaleString()} meat`;
}

function getAccountName(playerId: number): string {
  return playerId === PROMOTIONAL_ACCOUNT_ID
    ? "PROMOTIONAL (bot-owned)"
    : `Player ${playerId}`;
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
    cancelQueue: state.cancelQueue,
    chatQueues: {
      help: state.helpQueue,
      orders: state.ordersQueue,
      withdraw: state.withdrawQueue,
      balance: state.balanceQueue,
    },
  };
}
