import { gameData } from "kol.js";
import { Item } from "data-of-loathing";

export async function findItemByName(name: string): Promise<Item | null> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return null;
  }

  const exactMatch = await gameData.findItemByName(trimmedName);
  if (exactMatch) {
    return exactMatch;
  }

  const candidates = await gameData.query.find(Item, {
    name: { $ilike: trimmedName },
  });
  const normalizedName = trimmedName.toLowerCase();
  return (
    candidates.find((item) => item.name.toLowerCase() === normalizedName) ??
    null
  );
}

export async function getItemName(itemId: number): Promise<string> {
  const item = await gameData.findItemById(itemId);
  return item ? item.name : `Item #${itemId}`;
}
