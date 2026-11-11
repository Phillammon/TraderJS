import { config } from "../../config.js";
import { PROMOTIONAL_ACCOUNT_ID } from "../../state.js";

export function getCommandAccountId(requesterId: number): number {
  return requesterId === config.OPERATOR_ID
    ? PROMOTIONAL_ACCOUNT_ID
    : requesterId;
}

export async function getCurrentMeat(client: {
  fetchStatus: () => Promise<{ meat?: number | undefined }>;
}): Promise<number> {
  const totalMeat = (await client.fetchStatus()).meat;
  if (
    typeof totalMeat !== "number" ||
    !Number.isSafeInteger(totalMeat) ||
    totalMeat < 0
  ) {
    throw new TypeError("Could not determine the bot's current meat balance");
  }
  return totalMeat;
}
