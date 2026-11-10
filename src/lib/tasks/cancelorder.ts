import { gameData } from "kol.js";
import {
  PROMOTIONAL_ACCOUNT_ID,
  type TraderState,
} from "../state.js";
import { sendKmailMessage } from "./kmailutils.js";
import { getCommandAccountId } from "./commandaccount.js";
import { findItemByName } from "./itemutils.js";
import type { Task } from "../types.js";

type CancelResult = {
  message: string;
  rejectionReason?: string;
};

export async function cancelOrderForPlayer(
  state: TraderState,
  playerId: number,
  selector: string,
): Promise<CancelResult> {
  const itemName = selector.trim();
  let item = await findItemByName(itemName);
  if (!item && /^\d+$/.test(itemName)) {
    const itemId = Number(itemName);
    if (Number.isSafeInteger(itemId) && itemId > 0) {
      item = await gameData.findItemById(itemId);
    }
  }
  if (!item) {
    const reason = `Could not find an item named or numbered "${itemName}".`;
    return {
      message: `I couldn't cancel an order: ${reason}`,
      rejectionReason: reason,
    };
  }

  const releasedMeat = state.cancelBuyOrder(playerId, item.id);
  const accountDescription =
    playerId === PROMOTIONAL_ACCOUNT_ID
      ? "The bot doesn't"
      : "You don't";
  if (releasedMeat === 0) {
    return {
      message: `${accountDescription} have an active buy order for ${item.name} (item ${item.id}).`,
    };
  }
  return {
    message: playerId === PROMOTIONAL_ACCOUNT_ID
      ? `Cancelled the bot-funded buy order for ${item.name} (item ${item.id}) and released ${releasedMeat.toLocaleString()} bot-owned meat.`
      : `Cancelled your buy order for ${item.name} (item ${item.id}) and moved ${releasedMeat.toLocaleString()} reserved meat to your surplus.`,
  };
}

export const CancelOrderTask: Task = {
  name: "Cancel Order",
  done: async (_client, state) => state.cancelQueue.length === 0,
  execute: async (client, state) => {
    const request = state.cancelQueue[0];
    if (!request) {
      return true;
    }

    const accountId = getCommandAccountId(request.playerId);
    const result = await cancelOrderForPlayer(state, accountId, request.item);
    await sendKmailMessage(client, request.playerId, result.message);
    if (result.rejectionReason) {
      state.queueOperatorNotification(
        `chat-cancel:${request.playerId}:${Date.now()}`,
        `Player ${request.playerId} sent an invalid cancel command: ${result.rejectionReason} Selector: "${request.item}"`,
      );
    }
    state.completeCancelRequest(request);
    state.save();
    return true;
  },
};
