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
    const available = getWithdrawableAssets(stored);
    if (available.items.size === 0 && available.meat === 0) {
      await sendKmailMessage(
        client,
        playerId,
        "I can't currently send you anything. Your stored items and meat are either empty or reserved for active buy orders.",
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
      await sendKmailMessage(
        client,
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
