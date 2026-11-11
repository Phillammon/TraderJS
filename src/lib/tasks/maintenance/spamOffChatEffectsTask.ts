import { relevantItemsAndEffects } from "../../gameconstants.js";
import type { Task } from "../../types.js";

export const SpamOffChatEffectsTask: Task = {
  name: "Spamming Off Chat Effects",
  done: async (client) =>
    (
      await Promise.all(
        relevantItemsAndEffects.ANNOYING_EFFECTS.map(async (effect) => {
          return (await client.effects.remainingEffectTurns(effect)) ?? 0;
        }),
      )
    ).every((turns) => turns === 0),
  execute: async (client) => {
    await client.chat.macro("/talkie Spamming off annoying chat effect");
    return true;
  },
};
