import { getWithdrawableAssets } from "../orders.js";
import { PROMOTIONAL_ACCOUNT_ID } from "../state.js";
import { sendWithdrawal } from "./withdrawalsupport.js";
import { sendKmailMessage } from "./kmailutils.js";
import { getCommandAccountId, getCurrentMeat } from "./commandaccount.js";
import { getItemName } from "./itemutils.js";
import type { Task } from "../types.js";

export const WithdrawTask: Task = {
  name: "Withdraw",
  done: async (_client, state) => state.withdrawQueue.length === 0,
  execute: async (client, state) => {
    const playerId = state.peekChatRequest("withdraw");
    if (playerId === undefined) {
      return true;
    }

    const accountId = getCommandAccountId(playerId);
    const stored = state.getPlayer(accountId);
    if (accountId === PROMOTIONAL_ACCOUNT_ID) {
      const released = state.unallocatePromotionalAssets(
        await getCurrentMeat(client),
      );
      const items = await Promise.all(
        [...released.items].map(async ([itemId, quantity]) => {
          return `${quantity.toLocaleString()} x ${await getItemName(itemId)}`;
        }),
      );
      await sendKmailMessage(
        client,
        playerId,
        [
          "Unallocated the bot's promotional assets without sending them to a player.",
          `Meat unallocated: ${released.meat.toLocaleString()}.`,
          `Items unallocated: ${items.length > 0 ? items.join(", ") : "none"}.`,
          `Bot-funded orders still active: ${stored.orders.size}.`,
        ].join("\n"),
      );
      state.completeChatRequest("withdraw", playerId);
      state.save();
      return true;
    }
    const recipient = await client.players.fetch(playerId);
    if (!recipient) {
      await sendKmailMessage(
        client,
        playerId,
        "I couldn't verify your account right now, so I haven't sent your stored assets. Please try again later.",
      );
      state.completeChatRequest("withdraw", playerId);
      state.save();
      return true;
    }

    const usesGiftPackages = recipient.inHardcore || recipient.inRonin;
    if (usesGiftPackages) {
      await sendKmailMessage(
        client,
        playerId,
        "I can't send your stored assets while your account is in Hardcore or Ronin. Please message me `withdraw` again when you are no longer in that state.",
      );
      state.completeChatRequest("withdraw", playerId);
      state.save();
      return true;
    }

    const available = getWithdrawableAssets(stored);
    if (recipient.path === "Legacy of Loathing") {
      available.items.clear();
    }
    if (available.items.size === 0 && available.meat === 0) {
      await sendKmailMessage(
        client,
        playerId,
        recipient.path === "Legacy of Loathing" && stored.items.size > 0
          ? "I can't send you items while you are in Legacy of Loathing, and you have no withdrawable meat right now."
          : "I can't currently send you anything. Your stored items and meat are either empty or reserved for active buy orders.",
      );
      state.completeChatRequest("withdraw", playerId);
      state.save();
      return true;
    }

    if (
      recipient.path === "Legacy of Loathing" &&
      available.items.size > 0 &&
      available.meat > 0
    ) {
      await sendKmailMessage(
        client,
        playerId,
        "I'll send your available meat now. Your stored items will remain in your balance until your account can receive items.",
      );
    }
    await sendWithdrawal(client, playerId, available, stored, state);
    state.completeChatRequest("withdraw", playerId);
    state.save();
    return true;
  },
};
