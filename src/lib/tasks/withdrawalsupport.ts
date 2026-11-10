import { gameData, type Client } from "kol.js";
import type { Item } from "data-of-loathing";
import type {
  PlayerState,
  TradeTransaction,
  TraderState,
} from "../state.js";
import { getItemName } from "./itemutils.js";
import { sendKmailMessage } from "./kmailutils.js";

type TransactionAllocation = {
  transaction: TradeTransaction;
  quantity?: number;
  meat?: number;
};

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

export async function sendWithdrawal(
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

    await sendKmailMessage(client, playerId, message, {
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

export async function prepareWithdrawalReport(
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
