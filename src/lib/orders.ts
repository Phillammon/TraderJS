import type { BuyOrder, PlayerState } from "./state.js";

export type ActiveBuyOrder = {
  playerId: number;
  player: PlayerState;
  itemId: number;
  order: BuyOrder;
};

export function getOrderQuantity(meat: number, price: number): number {
  return price > 0 ? Math.floor(meat / price) : 0;
}

export function getReservedOrderMeat(player: PlayerState): number {
  return [...player.orders.values()].reduce(
    (total, order) => total + order.meat,
    0,
  );
}

export function getWithdrawableAssets(player: PlayerState): {
  meat: number;
  items: Map<number, number>;
} {
  const items = new Map(
    [...player.items].filter(
      ([, quantity]) => quantity > 0,
    ),
  );
  return {
    meat: Math.max(0, player.meat - getReservedOrderMeat(player)),
    items,
  };
}

export function getWithdrawableTradeMeat(player: PlayerState): number {
  const availableMeat = Math.max(
    0,
    player.meat - getReservedOrderMeat(player),
  );
  let tradeMeat = 0;
  for (const transaction of player.transactions) {
    if (transaction.type !== "sold") {
      continue;
    }
    if (
      !Number.isSafeInteger(transaction.remainingMeat) ||
      transaction.remainingMeat < 0 ||
      transaction.remainingMeat > Number.MAX_SAFE_INTEGER - tradeMeat
    ) {
      throw new RangeError("Withdrawable trade meat exceeds safe limits");
    }
    tradeMeat += transaction.remainingMeat;
  }
  return Math.min(availableMeat, tradeMeat);
}

export function getActiveBuyOrdersForItem(
  players: ReadonlyMap<number, PlayerState>,
  itemId: number,
  excludedPlayerId?: number,
): ActiveBuyOrder[] {
  return [...players.entries()]
    .flatMap(([playerId, player]) => {
      const order = player.orders.get(itemId);
      return playerId !== excludedPlayerId && order
        ? [{ playerId, player, itemId, order }]
        : [];
    })
    .filter(({ order }) => order.meat > 0 && order.price > 0)
    .sort(
      (a, b) =>
        b.order.price - a.order.price ||
        Date.parse(a.order.lastModified) - Date.parse(b.order.lastModified) ||
        a.playerId - b.playerId,
    );
}

export function aggregateBuyOrders(
  players: ReadonlyMap<number, PlayerState>,
  excludedPlayerId?: number,
): Map<number, Map<number, number>> {
  const aggregated = new Map<number, Map<number, number>>();
  for (const [playerId, player] of players) {
    if (playerId === excludedPlayerId) {
      continue;
    }

    for (const [itemId, order] of player.orders) {
      if (order.meat <= 0 || order.price <= 0) {
        continue;
      }

      let priceLevels = aggregated.get(itemId);
      if (!priceLevels) {
        priceLevels = new Map();
        aggregated.set(itemId, priceLevels);
      }
      const quantity = getOrderQuantity(order.meat, order.price);
      priceLevels.set(
        order.price,
        (priceLevels.get(order.price) ?? 0) + quantity,
      );
    }
  }
  return aggregated;
}
