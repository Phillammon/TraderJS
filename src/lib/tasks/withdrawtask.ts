import { getWithdrawableAssets } from "../orders.js";
import { sendWithdrawal } from "./withdrawalsupport.js";
import { sendKmailMessage } from "./kmailutils.js";
import type { Task } from "../types.js";

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
