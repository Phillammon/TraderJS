import * as fs from "node:fs";
import { config } from "./config.js";

export const MIN_BUY_ORDER_PRICE = 100;
export const MAX_BUY_ORDER_PRICE = 1_000_000_000;
export const PROMOTIONAL_ACCOUNT_ID = 0;

export type BuyOrder = {
  meat: number;
  price: number;
  lastModified: string;
};

export type PlayerState = {
  orders: Map<number, BuyOrder>;
  meat: number;
  items: Map<number, number>;
  surplusMeat: number;
  surplusItems: Map<number, number>;
  transactions: TradeTransaction[];
};

export type TradeTransaction =
  | {
      type: "bought";
      itemId: number;
      timestamp: string;
      price: number;
      quantity: number;
      remainingQuantity: number;
    }
  | {
      type: "sold";
      itemId: number;
      timestamp: string;
      price: number;
      quantity: number;
      meat: number;
      remainingMeat: number;
    };

export type AuditTransaction =
  | {
      type: "trade";
      sellerId: number;
      buyerId: number;
      itemId: number;
      timestamp: string;
      price: number;
      quantity: number;
    }
  | {
      type: "bought";
      playerId: number;
      itemId: number;
      timestamp: string;
      price: number;
      quantity: number;
    }
  | {
      type: "sold";
      playerId: number;
      itemId: number;
      timestamp: string;
      price: number;
      quantity: number;
      meat: number;
    }
  | {
      type: "withdrawn";
      playerId: number;
      timestamp: string;
      meat: number;
      items: Record<string, number>;
    }
  | {
      type: "sent";
      playerId: number;
      timestamp: string;
      meat: number;
      items: Record<string, number>;
    }
  | {
      type: "surplus";
      playerId: number;
      timestamp: string;
      meat: number;
      items: Record<string, number>;
    }
  | {
      type: "orderCancelled";
      playerId: number;
      itemId: number;
      timestamp: string;
      meat: number;
    }
  | {
      type: "unallocated";
      playerId: number;
      timestamp: string;
      meat: number;
      items: Record<string, number>;
    };

type StoredPlayerState = {
  orders: Record<string, BuyOrder>;
  meat: number;
  items: Record<string, number>;
  transactions: TradeTransaction[];
  surplusMeat?: number;
  surplusItems?: Record<string, number>;
};

type StoredState = {
  players: Record<string, StoredPlayerState>;
  lastBeacon?: number;
  lastChatPoll?: number;
  lastWithdrawalInterval?: number;
  lastLedgerLogInterval?: number;
  pendingAuditTransactions?: AuditTransaction[];
  processedKmailIds?: number[];
  pendingKmailReplies?: Record<string, { playerId: number; message: string }>;
  pendingOperatorNotifications?: Record<string, string>;
  cancelQueue?: { playerId: number; item: string }[];
  chatQueues?: Record<ChatCommand, number[]>;
};

export type ChatCommand = "help" | "orders" | "withdraw" | "balance";
export type CancelRequest = { playerId: number; item: string };

export class TraderState {
  public players = new Map<number, PlayerState>();
  public lastBeacon: number;
  public lastChatPoll = 0;
  public lastWithdrawalInterval = -1;
  public lastLedgerLogInterval = -1;
  public pendingAuditTransactions: AuditTransaction[] = [];
  public readonly processedKmailIds = new Set<number>();
  public readonly pendingKmailReplies = new Map<
    number,
    { playerId: number; message: string }
  >();
  public readonly pendingOperatorNotifications = new Map<string, string>();
  public readonly cancelQueue: CancelRequest[] = [];
  public readonly helpQueue: number[] = [];
  public readonly ordersQueue: number[] = [];
  public readonly withdrawQueue: number[] = [];
  public readonly balanceQueue: number[] = [];
  private readonly stateFile: string;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
    this.lastBeacon = this.currentBeacon();
    this.load();
  }

  public rollover(): void {
    this.save();
  }

  public getPlayer(playerId: number): PlayerState {
    if (
      !Number.isSafeInteger(playerId) ||
      (playerId <= 0 && playerId !== PROMOTIONAL_ACCOUNT_ID)
    ) {
      throw new RangeError(`Invalid player id: ${playerId}`);
    }

    let player = this.players.get(playerId);
    if (!player) {
      player = {
        orders: new Map(),
        meat: 0,
        items: new Map(),
        surplusMeat: 0,
        surplusItems: new Map(),
        transactions: [],
      };
      this.players.set(playerId, player);
    }

    return player;
  }

  public getOwnedMeat(totalMeat: number): number {
    if (!Number.isSafeInteger(totalMeat) || totalMeat < 0) {
      throw new RangeError(`Invalid total meat: ${totalMeat}`);
    }
    const userMeat = [...this.players]
      .filter(([playerId]) => playerId !== PROMOTIONAL_ACCOUNT_ID)
      .reduce((total, [, player]) => total + player.meat, 0);
    if (!Number.isSafeInteger(userMeat) || userMeat > totalMeat) {
      throw new RangeError(
        `Stored user meat (${userMeat}) exceeds bot meat (${totalMeat})`,
      );
    }
    return totalMeat - userMeat;
  }

  public syncPromotionalAccount(totalMeat: number): number {
    const ownedMeat = this.getOwnedMeat(totalMeat);
    const account = this.getPlayer(PROMOTIONAL_ACCOUNT_ID);
    const reservedMeat = [...account.orders.values()].reduce(
      (total, order) => total + order.meat,
      0,
    );
    if (!Number.isSafeInteger(reservedMeat) || reservedMeat > ownedMeat) {
      throw new RangeError(
        `Promotional orders reserve ${reservedMeat} meat but only ${ownedMeat} bot-owned meat is available`,
      );
    }
    account.meat = ownedMeat;
    account.surplusMeat = ownedMeat - reservedMeat;
    return ownedMeat - reservedMeat;
  }

  public createPromotionalBuyOrder(
    totalMeat: number,
    itemId: number,
    price: number,
    requestedQuantity: number | undefined,
    timestamp: Date,
  ): { quantity: number; allocatedMeat: number; releasedMeat: number } {
    if (
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      !Number.isSafeInteger(price) ||
      price < MIN_BUY_ORDER_PRICE ||
      price > MAX_BUY_ORDER_PRICE ||
      (requestedQuantity !== undefined &&
        (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0)) ||
      Number.isNaN(timestamp.getTime())
    ) {
      throw new RangeError("Invalid promotional buy order");
    }
    const availableMeat = this.syncPromotionalAccount(totalMeat);
    const account = this.getPlayer(PROMOTIONAL_ACCOUNT_ID);
    const existing = account.orders.get(itemId);
    const releasedMeat = existing?.meat ?? 0;
    const replacementAvailable = availableMeat + releasedMeat;
    const quantity =
      requestedQuantity ?? Math.floor(replacementAvailable / price);
    if (quantity <= 0) {
      throw new RangeError(
        `Promotional account does not have enough own meat to fund an item at ${price.toLocaleString()} meat each`,
      );
    }
    const allocatedMeat = quantity * price;
    if (
      !Number.isSafeInteger(allocatedMeat) ||
      allocatedMeat > replacementAvailable
    ) {
      throw new RangeError("Promotional order allocation exceeds safe limits");
    }
    account.orders.set(itemId, {
      meat: allocatedMeat,
      price,
      lastModified: timestamp.toISOString(),
    });
    account.surplusMeat =
      account.meat -
      ([...account.orders.values()].reduce(
        (total, order) => total + order.meat,
        0,
      ));
    return { quantity, allocatedMeat, releasedMeat };
  }

  public unallocatePromotionalAssets(
    totalMeat: number,
    timestamp = new Date(),
  ): {
    meat: number;
    items: Map<number, number>;
  } {
    if (Number.isNaN(timestamp.getTime())) {
      throw new RangeError("Invalid promotional unallocation timestamp");
    }
    this.syncPromotionalAccount(totalMeat);
    const account = this.getPlayer(PROMOTIONAL_ACCOUNT_ID);
    const reservedMeat = [...account.orders.values()].reduce(
      (total, order) => total + order.meat,
      0,
    );
    if (reservedMeat > account.meat) {
      throw new RangeError("Promotional orders exceed their allocated meat");
    }

    const meat = account.meat - reservedMeat;
    const items = new Map(
      [...account.items].filter(([, quantity]) => quantity > 0),
    );
    for (const [itemId, quantity] of items) {
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new RangeError(
          `Invalid promotional item quantity for item ${itemId}`,
        );
      }
    }
    account.meat = reservedMeat;
    account.surplusMeat = 0;
    for (const [itemId, quantity] of items) {
      let remaining = quantity;
      for (const transaction of account.transactions) {
        if (transaction.type !== "bought" || transaction.itemId !== itemId) {
          continue;
        }
        const unallocated = Math.min(remaining, transaction.remainingQuantity);
        transaction.remainingQuantity -= unallocated;
        remaining -= unallocated;
        if (remaining === 0) {
          break;
        }
      }
      account.items.delete(itemId);
      account.surplusItems.delete(itemId);
    }
    account.transactions = account.transactions.filter(
      (transaction) =>
        transaction.type !== "bought" || transaction.remainingQuantity > 0,
    );
    if (meat > 0 || items.size > 0) {
      this.pendingAuditTransactions.push({
        type: "unallocated",
        playerId: PROMOTIONAL_ACCOUNT_ID,
        timestamp: timestamp.toISOString(),
        meat,
        items: Object.fromEntries(items),
      });
    }
    return { meat, items };
  }

  public load(): void {
    this.players.clear();
    this.helpQueue.length = 0;
    this.ordersQueue.length = 0;
    this.withdrawQueue.length = 0;
    this.balanceQueue.length = 0;
    this.lastBeacon = this.currentBeacon();
    this.lastChatPoll = 0;
    this.lastWithdrawalInterval = -1;
    this.lastLedgerLogInterval = -1;
    this.pendingAuditTransactions.length = 0;
    this.processedKmailIds.clear();
    this.pendingKmailReplies.clear();
    this.pendingOperatorNotifications.clear();
    this.cancelQueue.length = 0;
    if (!fs.existsSync(this.stateFile)) {
      return;
    }

    const stored = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as unknown;
    if (!isRecord(stored) || !isRecord(stored.players)) {
      throw new TypeError(`Invalid state file format: ${this.stateFile}`);
    }
    if (stored.lastBeacon !== undefined) {
      if (
        typeof stored.lastBeacon !== "number" ||
        !Number.isSafeInteger(stored.lastBeacon) ||
        stored.lastBeacon < 0
      ) {
        throw new TypeError(`Invalid beacon state: ${this.stateFile}`);
      }
      this.lastBeacon = stored.lastBeacon;
    }
    if (stored.lastChatPoll !== undefined) {
      if (
        typeof stored.lastChatPoll !== "number" ||
        !Number.isSafeInteger(stored.lastChatPoll) ||
        stored.lastChatPoll < 0
      ) {
        throw new TypeError(`Invalid chat poll state: ${this.stateFile}`);
      }
      this.lastChatPoll = stored.lastChatPoll;
    }
    if (stored.lastWithdrawalInterval !== undefined) {
      if (
        typeof stored.lastWithdrawalInterval !== "number" ||
        !Number.isSafeInteger(stored.lastWithdrawalInterval) ||
        stored.lastWithdrawalInterval < -1
      ) {
        throw new TypeError(`Invalid withdrawal state: ${this.stateFile}`);
      }
      this.lastWithdrawalInterval = stored.lastWithdrawalInterval;
    }
    if (stored.lastLedgerLogInterval !== undefined) {
      if (
        typeof stored.lastLedgerLogInterval !== "number" ||
        !Number.isSafeInteger(stored.lastLedgerLogInterval) ||
        stored.lastLedgerLogInterval < -1
      ) {
        throw new TypeError(`Invalid ledger log state: ${this.stateFile}`);
      }
      this.lastLedgerLogInterval = stored.lastLedgerLogInterval;
    }
    this.pendingAuditTransactions = parseAuditTransactions(
      stored.pendingAuditTransactions,
    );
    if (stored.processedKmailIds !== undefined) {
      if (!Array.isArray(stored.processedKmailIds)) {
        throw new TypeError(`Invalid processed kmail ids: ${this.stateFile}`);
      }
      for (const id of stored.processedKmailIds) {
        if (!Number.isSafeInteger(id) || id <= 0) {
          throw new TypeError(`Invalid processed kmail id: ${this.stateFile}`);
        }
        this.processedKmailIds.add(id);
      }
    }
    if (stored.pendingKmailReplies !== undefined) {
      if (!isRecord(stored.pendingKmailReplies)) {
        throw new TypeError(`Invalid pending kmail replies: ${this.stateFile}`);
      }
      for (const [kmailIdText, reply] of Object.entries(
        stored.pendingKmailReplies,
      )) {
        const kmailId = parseId(kmailIdText, "kmail");
        if (
          !isRecord(reply) ||
          typeof reply.playerId !== "number" ||
          !Number.isSafeInteger(reply.playerId) ||
          reply.playerId <= 0 ||
          typeof reply.message !== "string"
        ) {
          throw new TypeError(`Invalid pending kmail reply ${kmailId}`);
        }
        this.pendingKmailReplies.set(kmailId, {
          playerId: reply.playerId,
          message: reply.message,
        });
      }
    }
    if (stored.pendingOperatorNotifications !== undefined) {
      if (!isRecord(stored.pendingOperatorNotifications)) {
        throw new TypeError(
          `Invalid pending operator notifications: ${this.stateFile}`,
        );
      }
      for (const [notificationId, message] of Object.entries(
        stored.pendingOperatorNotifications,
      )) {
        if (!notificationId || typeof message !== "string") {
          throw new TypeError(
            `Invalid pending operator notification: ${this.stateFile}`,
          );
        }
        this.pendingOperatorNotifications.set(notificationId, message);
      }
    }
    if (stored.cancelQueue !== undefined) {
      if (!Array.isArray(stored.cancelQueue)) {
        throw new TypeError(`Invalid cancel queue: ${this.stateFile}`);
      }
      for (const request of stored.cancelQueue) {
        if (
          !isRecord(request) ||
          typeof request.playerId !== "number" ||
          !Number.isSafeInteger(request.playerId) ||
          request.playerId <= 0 ||
          typeof request.item !== "string"
        ) {
          throw new TypeError(`Invalid cancel queue entry: ${this.stateFile}`);
        }
        this.cancelQueue.push({
          playerId: request.playerId,
          item: request.item,
        });
      }
    }
    if (stored.chatQueues !== undefined) {
      if (!isRecord(stored.chatQueues)) {
        throw new TypeError(`Invalid chat queues: ${this.stateFile}`);
      }
      for (const command of ["help", "orders", "withdraw", "balance"] as const) {
        const queue = stored.chatQueues[command];
        if (queue === undefined) {
          continue;
        }
        if (!Array.isArray(queue)) {
          throw new TypeError(`Invalid ${command} queue: ${this.stateFile}`);
        }
        for (const playerId of queue) {
          if (
            typeof playerId !== "number" ||
            !Number.isSafeInteger(playerId) ||
            playerId <= 0
          ) {
            throw new TypeError(`Invalid player id in ${command} queue`);
          }
          this.queueFor(command).push(playerId);
        }
      }
    }

    for (const [playerIdText, player] of Object.entries(stored.players)) {
      const playerId =
        playerIdText === String(PROMOTIONAL_ACCOUNT_ID)
          ? PROMOTIONAL_ACCOUNT_ID
          : parseId(playerIdText, "player");
      if (
        !isRecord(player) ||
        typeof player.meat !== "number" ||
        !isNonNegativeFinite(player.meat) ||
        !isRecord(player.orders) ||
        !isRecord(player.items)
      ) {
        throw new TypeError(`Invalid state for player ${playerId}`);
      }

      const orders = new Map<number, BuyOrder>();
      for (const [itemIdText, order] of Object.entries(player.orders)) {
        const itemId = parseId(itemIdText, "item");
        if (
          !isRecord(order) ||
          typeof order.meat !== "number" ||
          !isNonNegativeFinite(order.meat) ||
          typeof order.price !== "number" ||
          !isNonNegativeFinite(order.price) ||
          order.price < MIN_BUY_ORDER_PRICE ||
          order.price > MAX_BUY_ORDER_PRICE ||
          (order.lastModified !== undefined &&
            (typeof order.lastModified !== "string" ||
              Number.isNaN(Date.parse(order.lastModified))))
        ) {
          throw new TypeError(`Invalid buy order for item ${itemId}`);
        }
        orders.set(itemId, {
          meat: order.meat,
          price: order.price,
          lastModified:
            typeof order.lastModified === "string"
              ? order.lastModified
              : new Date(0).toISOString(),
        });
      }

      const items = new Map<number, number>();
      for (const [itemIdText, quantity] of Object.entries(player.items)) {
        const itemId = parseId(itemIdText, "item");
        if (typeof quantity !== "number" || !isNonNegativeFinite(quantity)) {
          throw new TypeError(`Invalid item quantity for item ${itemId}`);
        }
        items.set(itemId, quantity);
      }

      const surplusMeat = player.surplusMeat ?? 0;
      if (
        typeof surplusMeat !== "number" ||
        !Number.isSafeInteger(surplusMeat) ||
        surplusMeat < 0 ||
        surplusMeat > player.meat
      ) {
        throw new TypeError(`Invalid surplus meat for player ${playerId}`);
      }
      const surplusItems = new Map<number, number>();
      if (player.surplusItems !== undefined) {
        if (!isRecord(player.surplusItems)) {
          throw new TypeError(`Invalid surplus items for player ${playerId}`);
        }
        for (const [itemIdText, quantity] of Object.entries(
          player.surplusItems,
        )) {
          const itemId = parseId(itemIdText, "item");
          if (
            typeof quantity !== "number" ||
            !Number.isSafeInteger(quantity) ||
            quantity <= 0 ||
            quantity > (items.get(itemId) ?? 0)
          ) {
            throw new TypeError(`Invalid surplus quantity for item ${itemId}`);
          }
          surplusItems.set(itemId, quantity);
        }
      }

      const transactions = parseTransactions(player.transactions, playerId);
      this.players.set(playerId, {
        orders,
        meat: player.meat,
        items,
        surplusMeat,
        surplusItems,
        transactions,
      });
    }
  }

  public save(): void {
    const players: StoredState["players"] = {};
    for (const [playerId, player] of this.players) {
      players[playerId] = {
        orders: Object.fromEntries(player.orders),
        meat: player.meat,
        items: Object.fromEntries(player.items),
        transactions: player.transactions,
        surplusMeat: player.surplusMeat,
        surplusItems: Object.fromEntries(player.surplusItems),
      };
    }

    fs.writeFileSync(
      this.stateFile,
      JSON.stringify(
        {
          players,
          lastBeacon: this.lastBeacon,
          lastChatPoll: this.lastChatPoll,
          lastWithdrawalInterval: this.lastWithdrawalInterval,
          lastLedgerLogInterval: this.lastLedgerLogInterval,
          pendingAuditTransactions: this.pendingAuditTransactions,
          processedKmailIds: [...this.processedKmailIds],
          pendingKmailReplies: Object.fromEntries(this.pendingKmailReplies),
          pendingOperatorNotifications: Object.fromEntries(
            this.pendingOperatorNotifications,
          ),
          cancelQueue: this.cancelQueue,
          chatQueues: {
            help: this.helpQueue,
            orders: this.ordersQueue,
            withdraw: this.withdrawQueue,
            balance: this.balanceQueue,
          },
        } satisfies StoredState,
        null,
        2,
      ),
      "utf8",
    );
  }

  public enqueueChatRequest(command: ChatCommand, playerId: number): void {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
      throw new RangeError(`Invalid player id: ${playerId}`);
    }
    this.queueFor(command).push(playerId);
  }

  public enqueueCancelRequest(playerId: number, item: string): void {
    if (
      !Number.isSafeInteger(playerId) ||
      playerId <= 0 ||
      typeof item !== "string" ||
      !item.trim()
    ) {
      throw new TypeError("Invalid cancel request");
    }
    this.cancelQueue.push({ playerId, item: item.trim() });
  }

  public completeCancelRequest(request: CancelRequest): void {
    if (this.cancelQueue[0] !== request) {
      throw new Error("Unexpected cancel queue entry");
    }
    this.cancelQueue.shift();
  }

  public recordPurchase(
    playerId: number,
    itemId: number,
    quantity: number,
    price: number,
    timestamp = new Date(),
    options: {
      recordAudit?: boolean;
      reservedMeat?: number;
      selfDealing?: boolean;
    } = {},
  ): void {
    validateTrade(playerId, itemId, quantity, price, timestamp);
    const player = this.getPlayer(playerId);
    const totalPrice = quantity * price;
    const recordAudit = options.recordAudit ?? true;
    const reservedMeat = options.reservedMeat ?? 0;
    const selfDealing = options.selfDealing ?? false;
    if (
      !Number.isSafeInteger(reservedMeat) ||
      reservedMeat < 0 ||
      reservedMeat > totalPrice
    ) {
      throw new RangeError("Invalid reserved meat applied to purchase");
    }
    if (selfDealing && reservedMeat !== totalPrice) {
      throw new RangeError(
        "Self-dealing purchases must be fully funded by reserved order meat",
      );
    }
    if (player.meat < totalPrice) {
      throw new RangeError(`Player ${playerId} does not have enough stored meat`);
    }
    if (
      quantity >
      Number.MAX_SAFE_INTEGER - (player.items.get(itemId) ?? 0)
    ) {
      throw new RangeError(`Purchase quantity for item ${itemId} is too large`);
    }
    const saleProceeds = player.transactions.reduce(
      (total, transaction) =>
        transaction.type === "sold" ? total + transaction.remainingMeat : total,
      0,
    );
    const unreservedPrice = selfDealing ? 0 : totalPrice - reservedMeat;
    if (saleProceeds + player.surplusMeat < unreservedPrice) {
      throw new RangeError(
        `Player ${playerId} does not have enough accounted meat to fund the purchase`,
      );
    }

    const spentSurplus = Math.min(player.surplusMeat, unreservedPrice);
    player.surplusMeat -= spentSurplus;
    let remainingSaleProceeds = unreservedPrice - spentSurplus;
    for (const transaction of player.transactions) {
      if (transaction.type !== "sold") {
        continue;
      }
      const consumed = Math.min(
        remainingSaleProceeds,
        transaction.remainingMeat,
      );
      transaction.remainingMeat -= consumed;
      remainingSaleProceeds -= consumed;
      if (remainingSaleProceeds === 0) {
        break;
      }
    }
    if (!selfDealing) {
      player.meat -= totalPrice;
    }
    player.items.set(itemId, (player.items.get(itemId) ?? 0) + quantity);
    player.transactions.push({
      type: "bought",
      itemId,
      timestamp: timestamp.toISOString(),
      price,
      quantity,
      remainingQuantity: quantity,
    });
    if (recordAudit) {
      this.pendingAuditTransactions.push({
        type: "bought",
        playerId,
        itemId,
        timestamp: timestamp.toISOString(),
        price,
        quantity,
      });
    }
  }

  public recordSale(
    playerId: number,
    itemId: number,
    quantity: number,
    price: number,
    timestamp = new Date(),
    recordAudit = true,
  ): void {
    validateTrade(playerId, itemId, quantity, price, timestamp);
    const player = this.getPlayer(playerId);
    const itemQuantity = player.items.get(itemId) ?? 0;
    if (itemQuantity < quantity) {
      throw new RangeError(`Player ${playerId} does not have enough item ${itemId}`);
    }
    const meat = quantity * price;
    if (!Number.isSafeInteger(meat)) {
      throw new RangeError("Sale proceeds exceed the safe integer range");
    }
    if (meat > Number.MAX_SAFE_INTEGER - player.meat) {
      throw new RangeError("Sale proceeds exceed the safe integer range");
    }

    const boughtQuantity = player.transactions.reduce(
      (total, transaction) =>
        transaction.type === "bought" && transaction.itemId === itemId
          ? total + transaction.remainingQuantity
          : total,
      0,
    );
    const spentSurplus = Math.max(0, quantity - boughtQuantity);
    const surplusQuantity = player.surplusItems.get(itemId) ?? 0;
    if (spentSurplus > surplusQuantity) {
      throw new RangeError(
        `Player ${playerId} does not have enough accounted item ${itemId} to sell`,
      );
    }

    let remainingSoldQuantity = quantity;
    for (const transaction of player.transactions) {
      if (transaction.type !== "bought" || transaction.itemId !== itemId) {
        continue;
      }
      const consumed = Math.min(
        remainingSoldQuantity,
        transaction.remainingQuantity,
      );
      transaction.remainingQuantity -= consumed;
      remainingSoldQuantity -= consumed;
      if (remainingSoldQuantity === 0) {
        break;
      }
    }
    if (spentSurplus > 0) {
      const remainingSurplus = surplusQuantity - spentSurplus;
      if (remainingSurplus > 0) {
        player.surplusItems.set(itemId, remainingSurplus);
      } else {
        player.surplusItems.delete(itemId);
      }
    }

    const remainingQuantity = itemQuantity - quantity;
    if (remainingQuantity > 0) {
      player.items.set(itemId, remainingQuantity);
    } else {
      player.items.delete(itemId);
    }
    player.meat += meat;
    player.transactions.push({
      type: "sold",
      itemId,
      timestamp: timestamp.toISOString(),
      price,
      quantity,
      meat,
      remainingMeat: meat,
    });
    if (recordAudit) {
      this.pendingAuditTransactions.push({
        type: "sold",
        playerId,
        itemId,
        timestamp: timestamp.toISOString(),
        price,
        quantity,
        meat,
      });
    }
  }

  public recordTradeAudit(
    sellerId: number,
    buyerId: number,
    itemId: number,
    quantity: number,
    price: number,
    timestamp: Date,
  ): void {
    if (
      !Number.isSafeInteger(sellerId) ||
      sellerId <= 0 ||
      !Number.isSafeInteger(buyerId) ||
      (buyerId <= 0 && buyerId !== PROMOTIONAL_ACCOUNT_ID) ||
      sellerId === buyerId
    ) {
      throw new RangeError("Invalid trade participants");
    }
    validateTrade(sellerId, itemId, quantity, price, timestamp);
    this.pendingAuditTransactions.push({
      type: "trade",
      sellerId,
      buyerId,
      itemId,
      timestamp: timestamp.toISOString(),
      price,
      quantity,
    });
  }

  public recordWithdrawal(
    playerId: number,
    meat: number,
    items: ReadonlyMap<number, number>,
    timestamp = new Date(),
  ): void {
    this.recordAssetTransfer("withdrawn", playerId, meat, items, timestamp);
  }

  public recordSent(
    playerId: number,
    meat: number,
    items: ReadonlyMap<number, number>,
    surplus: { meat: number; items: ReadonlyMap<number, number> },
    timestamp = new Date(),
  ): void {
    const player = this.getPlayer(playerId);
    if (
      !Number.isSafeInteger(surplus.meat) ||
      surplus.meat < 0 ||
      surplus.meat > meat ||
      surplus.meat > player.surplusMeat
    ) {
      throw new RangeError(`Invalid surplus meat sent for player ${playerId}`);
    }
    for (const [itemId, quantity] of surplus.items) {
      if (
        !Number.isSafeInteger(itemId) ||
        itemId <= 0 ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        quantity > (items.get(itemId) ?? 0) ||
        quantity > (player.surplusItems.get(itemId) ?? 0)
      ) {
        throw new RangeError(
          `Invalid surplus quantity sent for item ${itemId}`,
        );
      }
    }
    this.recordAssetTransfer("sent", playerId, meat, items, timestamp);
    player.surplusMeat -= surplus.meat;
    for (const [itemId, quantity] of surplus.items) {
      const remaining = (player.surplusItems.get(itemId) ?? 0) - quantity;
      if (remaining > 0) {
        player.surplusItems.set(itemId, remaining);
      } else {
        player.surplusItems.delete(itemId);
      }
    }
  }

  public recordSurplus(
    playerId: number,
    meat: number,
    items: ReadonlyMap<number, number>,
    timestamp = new Date(),
    recordAudit = true,
  ): void {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
      throw new RangeError(`Invalid player id: ${playerId}`);
    }
    if (!Number.isSafeInteger(meat) || meat < 0) {
      throw new RangeError(`Invalid surplus meat: ${meat}`);
    }
    if (Number.isNaN(timestamp.getTime())) {
      throw new RangeError("Invalid surplus timestamp");
    }

    const player = this.getPlayer(playerId);
    if (meat > Number.MAX_SAFE_INTEGER - player.meat) {
      throw new RangeError(`Surplus meat exceeds the safe integer range`);
    }
    if (meat > Number.MAX_SAFE_INTEGER - player.surplusMeat) {
      throw new RangeError(`Surplus meat exceeds the safe integer range`);
    }
    for (const [itemId, quantity] of items) {
      if (
        !Number.isSafeInteger(itemId) ||
        itemId <= 0 ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      ) {
        throw new RangeError(`Invalid surplus item ${itemId}: ${quantity}`);
      }
      if (
        quantity > Number.MAX_SAFE_INTEGER - (player.items.get(itemId) ?? 0) ||
        quantity >
          Number.MAX_SAFE_INTEGER - (player.surplusItems.get(itemId) ?? 0)
      ) {
        throw new RangeError(`Surplus quantity for item ${itemId} is too large`);
      }

    }

    player.meat += meat;
    player.surplusMeat += meat;
    for (const [itemId, quantity] of items) {
      player.items.set(itemId, (player.items.get(itemId) ?? 0) + quantity);
      player.surplusItems.set(
        itemId,
        (player.surplusItems.get(itemId) ?? 0) + quantity,
      );
    }
    if (recordAudit) {
      this.recordSurplusAudit(playerId, meat, items, timestamp);
    }
  }

  public recordSurplusAudit(
    playerId: number,
    meat: number,
    items: ReadonlyMap<number, number>,
    timestamp: Date,
  ): void {
    if (
      !Number.isSafeInteger(playerId) ||
      playerId <= 0 ||
      !Number.isSafeInteger(meat) ||
      meat < 0 ||
      Number.isNaN(timestamp.getTime())
    ) {
      throw new RangeError("Invalid surplus audit entry");
    }
    for (const [itemId, quantity] of items) {
      if (
        !Number.isSafeInteger(itemId) ||
        itemId <= 0 ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      ) {
        throw new RangeError(`Invalid surplus audit item ${itemId}`);
      }
    }
    if (meat === 0 && items.size === 0) {
      return;
    }
    this.pendingAuditTransactions.push({
      type: "surplus",
      playerId,
      timestamp: timestamp.toISOString(),
      meat,
      items: Object.fromEntries(items),
    });
  }

  public markKmailProcessed(
    kmailId: number,
    reply?: { playerId: number; message: string },
  ): void {
    if (!Number.isSafeInteger(kmailId) || kmailId <= 0) {
      throw new RangeError(`Invalid kmail id: ${kmailId}`);
    }
    if (
      reply &&
      (!Number.isSafeInteger(reply.playerId) ||
        reply.playerId <= 0 ||
        typeof reply.message !== "string")
    ) {
      throw new TypeError(`Invalid reply for kmail ${kmailId}`);
    }
    this.processedKmailIds.add(kmailId);
    if (reply) {
      this.pendingKmailReplies.set(kmailId, reply);
    }
  }

  public completeKmailReply(kmailId: number): void {
    this.pendingKmailReplies.delete(kmailId);
  }

  public queueOperatorNotification(id: string, message: string): void {
    if (!id || !message) {
      throw new TypeError("Operator notification id and message are required");
    }
    this.pendingOperatorNotifications.set(id, message);
  }

  public completeOperatorNotification(id: string): void {
    this.pendingOperatorNotifications.delete(id);
  }

  public createBuyOrderFromSurplus(
    playerId: number,
    itemId: number,
    meat: number,
    price: number,
    timestamp: Date,
    additionalSurplusMeat = 0,
  ): number {
    if (
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      !Number.isSafeInteger(meat) ||
      meat <= 0 ||
      !Number.isSafeInteger(additionalSurplusMeat) ||
      additionalSurplusMeat < 0 ||
      !Number.isSafeInteger(price) ||
      price < MIN_BUY_ORDER_PRICE ||
      price > MAX_BUY_ORDER_PRICE ||
      Number.isNaN(timestamp.getTime())
    ) {
      throw new RangeError("Invalid buy order");
    }
    const player = this.getPlayer(playerId);
    const quantity = Math.floor(meat / price);
    if (quantity <= 0) {
      throw new RangeError("Buy order meat must cover at least one item");
    }
    const allocatedMeat = quantity * price;
    if (!Number.isSafeInteger(allocatedMeat) || allocatedMeat > meat) {
      throw new RangeError("Buy order allocation exceeds available meat");
    }
    const existing = player.orders.get(itemId);
    const releasedMeat = existing?.meat ?? 0;
    const totalMeat = player.surplusMeat + additionalSurplusMeat;
    const availableMeat = totalMeat + releasedMeat;
    if (
      !Number.isSafeInteger(totalMeat) ||
      !Number.isSafeInteger(availableMeat) ||
      additionalSurplusMeat > Number.MAX_SAFE_INTEGER - player.meat
    ) {
      throw new RangeError("Available buy order meat exceeds safe limits");
    }
    if (availableMeat < allocatedMeat) {
      throw new RangeError(
        `Player ${playerId} does not have enough surplus meat to fund the order`,
      );
    }
    player.meat += additionalSurplusMeat;
    player.surplusMeat = availableMeat - allocatedMeat;
    player.orders.set(itemId, {
      meat: allocatedMeat,
      price,
      lastModified: timestamp.toISOString(),
    });
    return releasedMeat;
  }

  public cancelBuyOrder(
    playerId: number,
    itemId: number,
    timestamp = new Date(),
  ): number {
    if (
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      Number.isNaN(timestamp.getTime())
    ) {
      throw new RangeError("Invalid buy order cancellation");
    }
    const player = this.getPlayer(playerId);
    const order = player.orders.get(itemId);
    if (!order) {
      return 0;
    }
    if (
      !Number.isSafeInteger(order.meat) ||
      order.meat < 0 ||
      order.meat > player.meat ||
      order.meat > Number.MAX_SAFE_INTEGER - player.surplusMeat
    ) {
      throw new RangeError(`Cannot safely release order meat for player ${playerId}`);
    }
    player.orders.delete(itemId);
    player.surplusMeat += order.meat;
    this.pendingAuditTransactions.push({
      type: "orderCancelled",
      playerId,
      itemId,
      timestamp: timestamp.toISOString(),
      meat: order.meat,
    });
    return order.meat;
  }

  private recordAssetTransfer(
    type: "withdrawn" | "sent",
    playerId: number,
    meat: number,
    items: ReadonlyMap<number, number>,
    timestamp: Date,
  ): void {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
      throw new RangeError(`Invalid player id: ${playerId}`);
    }
    if (!Number.isSafeInteger(meat) || meat < 0) {
      throw new RangeError(`Invalid ${type} meat: ${meat}`);
    }
    if (Number.isNaN(timestamp.getTime())) {
      throw new RangeError(`Invalid ${type} timestamp`);
    }

    const player = this.getPlayer(playerId);
    if (player.meat < meat) {
      throw new RangeError(`Player ${playerId} does not have enough stored meat`);
    }
    const withdrawnItems: Record<string, number> = {};
    for (const [itemId, quantity] of items) {
      if (!Number.isSafeInteger(itemId) || itemId <= 0) {
        throw new RangeError(`Invalid item id: ${itemId}`);
      }
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new RangeError(`Invalid ${type} quantity: ${quantity}`);
      }
      if ((player.items.get(itemId) ?? 0) < quantity) {
        throw new RangeError(
          `Player ${playerId} does not have enough item ${itemId}`,
        );
      }
      withdrawnItems[itemId] = quantity;
    }

    player.meat -= meat;
    for (const [itemId, quantity] of items) {
      const remaining = (player.items.get(itemId) ?? 0) - quantity;
      if (remaining > 0) {
        player.items.set(itemId, remaining);
      } else {
        player.items.delete(itemId);
      }
    }
    this.pendingAuditTransactions.push({
      type,
      playerId,
      timestamp: timestamp.toISOString(),
      meat,
      items: withdrawnItems,
    });
  }

  public peekChatRequest(command: ChatCommand): number | undefined {
    return this.queueFor(command)[0];
  }

  public completeChatRequest(command: ChatCommand, playerId: number): void {
    const queue = this.queueFor(command);
    if (queue[0] !== playerId) {
      throw new Error(`Unexpected ${command} queue entry for player ${playerId}`);
    }
    queue.shift();
  }

  private currentBeacon(): number {
    return Math.floor(Date.now() / (1000 * config.TRADE_BEACON_DELAY));
  }

  private queueFor(command: ChatCommand): number[] {
    switch (command) {
      case "help":
        return this.helpQueue;
      case "orders":
        return this.ordersQueue;
      case "withdraw":
        return this.withdrawQueue;
      case "balance":
        return this.balanceQueue;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validateTrade(
  playerId: number,
  itemId: number,
  quantity: number,
  price: number,
  timestamp: Date,
): void {
  if (
    !Number.isSafeInteger(playerId) ||
    (playerId <= 0 && playerId !== PROMOTIONAL_ACCOUNT_ID)
  ) {
    throw new RangeError(`Invalid player id: ${playerId}`);
  }
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new RangeError(`Invalid item id: ${itemId}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError(`Invalid trade quantity: ${quantity}`);
  }
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new RangeError(`Invalid trade price: ${price}`);
  }
  if (Number.isNaN(timestamp.getTime())) {
    throw new RangeError("Invalid trade timestamp");
  }
  if (!Number.isSafeInteger(quantity * price)) {
    throw new RangeError("Trade value exceeds the safe integer range");
  }
}

function parseTransactions(
  input: unknown,
  playerId: number,
): TradeTransaction[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`Invalid transactions for player ${playerId}`);
  }

  return input.map((transaction, index) => {
    if (
      !isRecord(transaction) ||
      (transaction.type !== "bought" && transaction.type !== "sold") ||
      typeof transaction.itemId !== "number" ||
      !Number.isSafeInteger(transaction.itemId) ||
      transaction.itemId <= 0 ||
      typeof transaction.timestamp !== "string" ||
      Number.isNaN(Date.parse(transaction.timestamp)) ||
      typeof transaction.price !== "number" ||
      !Number.isSafeInteger(transaction.price) ||
      transaction.price <= 0 ||
      typeof transaction.quantity !== "number" ||
      !Number.isSafeInteger(transaction.quantity) ||
      transaction.quantity <= 0
    ) {
      throw new TypeError(
        `Invalid transaction ${index} for player ${playerId}`,
      );
    }

    if (transaction.type === "bought") {
      if (
        typeof transaction.remainingQuantity !== "number" ||
        !Number.isSafeInteger(transaction.remainingQuantity) ||
        transaction.remainingQuantity < 0 ||
        transaction.remainingQuantity > transaction.quantity
      ) {
        throw new TypeError(
          `Invalid remaining quantity in transaction ${index} for player ${playerId}`,
        );
      }
      return {
        type: "bought",
        itemId: transaction.itemId,
        timestamp: transaction.timestamp,
        price: transaction.price,
        quantity: transaction.quantity,
        remainingQuantity: transaction.remainingQuantity,
      };
    }

    const expectedMeat = transaction.quantity * transaction.price;
    if (
      !Number.isSafeInteger(expectedMeat) ||
      transaction.meat !== expectedMeat ||
      typeof transaction.remainingMeat !== "number" ||
      !Number.isSafeInteger(transaction.remainingMeat) ||
      transaction.remainingMeat < 0 ||
      transaction.remainingMeat > transaction.meat
    ) {
      throw new TypeError(
        `Invalid meat in transaction ${index} for player ${playerId}`,
      );
    }
    return {
      type: "sold",
      itemId: transaction.itemId,
      timestamp: transaction.timestamp,
      price: transaction.price,
      quantity: transaction.quantity,
      meat: transaction.meat,
      remainingMeat: transaction.remainingMeat,
    };
  });
}

function parseAuditTransactions(input: unknown): AuditTransaction[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new TypeError("Invalid pending audit transaction list");
  }

  return input.map((transaction, index) => {
    if (
      !isRecord(transaction) ||
      typeof transaction.timestamp !== "string" ||
      Number.isNaN(Date.parse(transaction.timestamp))
    ) {
      throw new TypeError(`Invalid audit transaction ${index}`);
    }

    if (transaction.type === "trade") {
      if (
        typeof transaction.sellerId !== "number" ||
        !Number.isSafeInteger(transaction.sellerId) ||
        transaction.sellerId <= 0 ||
        typeof transaction.buyerId !== "number" ||
        !Number.isSafeInteger(transaction.buyerId) ||
        (transaction.buyerId <= 0 &&
          transaction.buyerId !== PROMOTIONAL_ACCOUNT_ID) ||
        transaction.sellerId === transaction.buyerId ||
        typeof transaction.itemId !== "number" ||
        !Number.isSafeInteger(transaction.itemId) ||
        transaction.itemId <= 0 ||
        typeof transaction.price !== "number" ||
        !Number.isSafeInteger(transaction.price) ||
        transaction.price <= 0 ||
        typeof transaction.quantity !== "number" ||
        !Number.isSafeInteger(transaction.quantity) ||
        transaction.quantity <= 0 ||
        !Number.isSafeInteger(transaction.price * transaction.quantity)
      ) {
        throw new TypeError(`Invalid trade audit transaction ${index}`);
      }
      return {
        type: "trade",
        sellerId: transaction.sellerId,
        buyerId: transaction.buyerId,
        itemId: transaction.itemId,
        timestamp: transaction.timestamp,
        price: transaction.price,
        quantity: transaction.quantity,
      };
    }

    if (
      typeof transaction.playerId !== "number" ||
      !Number.isSafeInteger(transaction.playerId) ||
      (transaction.playerId <= 0 &&
        transaction.playerId !== PROMOTIONAL_ACCOUNT_ID)
    ) {
      throw new TypeError(`Invalid audit transaction ${index}`);
    }

    if (transaction.type === "orderCancelled") {
      if (
        typeof transaction.itemId !== "number" ||
        !Number.isSafeInteger(transaction.itemId) ||
        transaction.itemId <= 0 ||
        typeof transaction.meat !== "number" ||
        !Number.isSafeInteger(transaction.meat) ||
        transaction.meat < 0
      ) {
        throw new TypeError(`Invalid order cancellation audit transaction ${index}`);
      }
      return {
        type: "orderCancelled",
        playerId: transaction.playerId,
        itemId: transaction.itemId,
        timestamp: transaction.timestamp,
        meat: transaction.meat,
      };
    }

    if (
      transaction.type === "bought" ||
      transaction.type === "sold"
    ) {
      if (
        typeof transaction.itemId !== "number" ||
        !Number.isSafeInteger(transaction.itemId) ||
        transaction.itemId <= 0 ||
        typeof transaction.price !== "number" ||
        !Number.isSafeInteger(transaction.price) ||
        transaction.price <= 0 ||
        typeof transaction.quantity !== "number" ||
        !Number.isSafeInteger(transaction.quantity) ||
        transaction.quantity <= 0
      ) {
        throw new TypeError(`Invalid trade audit transaction ${index}`);
      }

      if (transaction.type === "bought") {
        return {
          type: "bought",
          playerId: transaction.playerId,
          itemId: transaction.itemId,
          timestamp: transaction.timestamp,
          price: transaction.price,
          quantity: transaction.quantity,
        };
      }

      const meat = transaction.quantity * transaction.price;
      if (!Number.isSafeInteger(meat) || transaction.meat !== meat) {
        throw new TypeError(`Invalid sale audit transaction ${index}`);
      }
      return {
        type: "sold",
        playerId: transaction.playerId,
        itemId: transaction.itemId,
        timestamp: transaction.timestamp,
        price: transaction.price,
        quantity: transaction.quantity,
        meat,
      };
    }

    if (
      (transaction.type === "withdrawn" ||
        transaction.type === "sent" ||
        transaction.type === "surplus" ||
        transaction.type === "unallocated") &&
      Number.isSafeInteger(transaction.meat) &&
      (transaction.meat as number) >= 0 &&
      isRecord(transaction.items)
    ) {
      const items: Record<string, number> = {};
      for (const [itemIdText, quantity] of Object.entries(transaction.items)) {
        const itemId = parseId(itemIdText, "item");
        if (
          typeof quantity !== "number" ||
          !Number.isSafeInteger(quantity) ||
          quantity <= 0
        ) {
          throw new TypeError(`Invalid asset audit item ${itemId}`);
        }
        items[itemIdText] = quantity;
      }
      return {
        type: transaction.type,
        playerId: transaction.playerId,
        timestamp: transaction.timestamp,
        meat: transaction.meat as number,
        items,
      };
    }

    throw new TypeError(`Invalid audit transaction ${index}`);
  });
}

function parseId(value: string, kind: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`Invalid ${kind} id in state file: ${value}`);
  }
  return id;
}
