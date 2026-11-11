import { config } from "../config.js";
import {
  getWithdrawableAssets,
  getWithdrawableTradeMeat,
} from "../orders.js";
import { PROMOTIONAL_ACCOUNT_ID } from "../state.js";
import { sendWithdrawal } from "./withdrawalsupport.js";
import type { Task } from "../types.js";

function getWithdrawalInterval(): number {
  return Math.floor(Date.now() / (1000 * config.WITHDRAWAL_DELAY));
}

export const RegularWithdrawTask: Task = {
  name: "Regular Withdrawals",
  done: async (_client, state) =>
    state.lastWithdrawalInterval === getWithdrawalInterval(),
  execute: async (client, state) => {
    for (const [playerId, stored] of state.players) {
      if (playerId === PROMOTIONAL_ACCOUNT_ID) {
        const totalMeat = (await client.fetchStatus()).meat;
        if (
          typeof totalMeat !== "number" ||
          !Number.isSafeInteger(totalMeat) ||
          totalMeat < 0
        ) {
          throw new TypeError(
            "Could not determine the bot's current meat balance for unallocation",
          );
        }
        state.unallocatePromotionalAssets(totalMeat);
        state.save();
        continue;
      }
      const available = getWithdrawableAssets(stored);
      available.meat = getWithdrawableTradeMeat(stored);
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
