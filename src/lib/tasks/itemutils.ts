import { gameData } from "kol.js";

export async function getItemName(itemId: number): Promise<string> {
  const item = await gameData.findItemById(itemId);
  return item ? item.name : `Item #${itemId}`;
}
