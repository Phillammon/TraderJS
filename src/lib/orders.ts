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
      ([itemId, quantity]) => quantity > 0 && !player.orders.has(itemId),
    ),
  );
  return {
    meat: Math.max(0, player.meat - getReservedOrderMeat(player)),
    items,
  };
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
): Map<number, Map<number, number>> {
  const aggregated = new Map<number, Map<number, number>>();
  for (const player of players.values()) {
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
