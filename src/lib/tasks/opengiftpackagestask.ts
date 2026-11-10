import { relevantItemsAndEffects } from "../gameconstants.js";
import type { Task } from "../types.js";

export const OpenGiftPackagesTask: Task = {
  name: "Open Gift Packages",
  done: async (client) =>
    (
      await Promise.all(
        relevantItemsAndEffects.PACKAGES.map(async (giftPackage) => {
          return (await client.inventory.get()).get(giftPackage) ?? 0;
        }),
      )
    ).every((quantity) => quantity === 0),
  execute: async (client) => {
    const packages = (
      await Promise.all(
        relevantItemsAndEffects.PACKAGES.map(
          async (giftPackage) =>
            [
              giftPackage,
              (await client.inventory.get()).get(giftPackage) ?? 0,
            ] as const,
        ),
      )
    )
      .filter(([, quantity]) => quantity > 0)
      .map(([giftPackage]) => giftPackage);

    for (const giftPackage of packages) {
      await client.fetchText("inv_use.php", {
        method: "GET",
        query: {
          which: 3,
          whichitem: giftPackage.id,
        },
      });
    }
    return true;
  },
};
