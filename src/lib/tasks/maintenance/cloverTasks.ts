import type { Task } from "../../types.js";
import { relevantItemsAndEffects } from "../../gameconstants.js";

export const GetWorthless: Task = {
  name: "Get Worthless Trinkets",
  done: async (client) => {
    return (
      await Promise.all(
        relevantItemsAndEffects.TRINKETS.map(async (trinket) => {
          return (await client.inventory.get()).get(trinket) ?? 0;
        }),
      )
    ).every((val) => val > 0);
  },
  execute: async (client) => {
    await client.fetchText("shop.php", {
      method: "GET",
      query: {
        whichshop: "generalstore",
        action: "buyitem",
        quantity: 1,
        whichrow: 648,
      },
    });
    await client.fetchText("inv_use.php", {
      method: "GET",
      query: {
        which: 3,
        whichitem: 23,
      },
    });
    return true;
  },
};

export const GetClovers: Task = {
  name: "Get 11-leaf Clovers",
  done: async (client) => {
    const hermitText = await client.fetchText("hermit.php", {
      method: "GET",
    });
    return hermitText.includes("out of stock for today");
  },
  execute: async (client) => {
    await client.fetchText("hermit.php", {
      method: "POST",
      query: {
        action: "trade",
        whichitem: "10881",
        quantity: "1",
      },
    });
    return true;
  },
};

export const StockClovers: Task = {
  name: "Stock clovers in mall",
  done: async (client) => {
    return !(await client.inventory.get()).get(relevantItemsAndEffects.CLOVER);
  },
  execute: async (client) => {
    await client.fetchText("backoffice.php", {
      method: "GET",
      query: {
        itemid: "10881",
        quantity: "*",
        price: "30000",
        limit: "",
        action: "additem",
        neveragain: 0,
        priceok: 0,
      },
    });
    return true;
  },
};
