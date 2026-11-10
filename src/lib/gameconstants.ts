import type { Effect, Item } from "data-of-loathing";
import { gameData } from "kol.js";

class RelevantItemsAndEffects {
  private packages: Item[] | undefined;
  private annoyingEffects: Effect[] | undefined;

  public get PACKAGES(): Item[] {
    if (!this.packages) {
      throw new Error("Relevant items and effects have not been loaded");
    }
    return this.packages;
  }

  public get ANNOYING_EFFECTS(): Effect[] {
    if (!this.annoyingEffects) {
      throw new Error("Relevant items and effects have not been loaded");
    }
    return this.annoyingEffects;
  }

  public async load(): Promise<void> {
    this.packages = await Promise.all(
      [
        1167, 1168, 1169, 1170, 1171, 1172, 1173, 1174, 1175, 1176, 1177,
        1460,
      ].map(async (itemId) => {
        const item = await gameData.findItemById(itemId);
        if (!item) {
          throw new Error(`Could not find item ${itemId}`);
        }
        return item;
      }),
    );
    this.annoyingEffects = await Promise.all(
      ["Harpooned and Marooned", "On Safari"].map(async (effectName) => {
        const effect = await gameData.findEffectByName(effectName);
        if (!effect) {
          throw new Error(`Could not find effect ${effectName}`);
        }
        return effect;
      }),
    );
  }
}

export const relevantItemsAndEffects = new RelevantItemsAndEffects();

export const loadRelevantItemsAndEffects = async (): Promise<void> => {
  await relevantItemsAndEffects.load();
};
