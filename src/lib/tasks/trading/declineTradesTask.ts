import { sendKmailMessage } from "../communication/kmailUtils.js";
import type { Task } from "../../types.js";

const TRADE_DECLINE_MESSAGE =
  "TheTrader does not support trades, only kmails. Please send me a kmail instead with the items you wish to sell attached (or in a giftbox).";

type IncomingTradeOffer = {
  offerId: number;
  senderId: number;
};

function getIncomingTradeOffers(html: string): IncomingTradeOffer[] {
  const offers: IncomingTradeOffer[] = [];
  const senderMatches = [...html.matchAll(/Offer\s+from[^<(]*\(#(\d+)\)/gi)];

  for (let index = 0; index < senderMatches.length; index++) {
    const senderMatch = senderMatches[index];
    if (!senderMatch || senderMatch.index === undefined) continue;

    const senderId = Number(senderMatch[1]);
    const sectionStart = senderMatch.index;
    const sectionEnd = senderMatches[index + 1]?.index ?? html.length;
    const section = html.slice(sectionStart, sectionEnd);
    const offerMatch = section.match(
      /(?:counteroffer|makeoffer)\.php\?[^"'<]*whichoffer=(\d+)/i,
    );

    if (Number.isSafeInteger(senderId) && senderId > 0 && offerMatch) {
      const offerId = Number(offerMatch[1]);
      if (Number.isSafeInteger(offerId) && offerId > 0) {
        offers.push({ offerId, senderId });
      }
    }
  }

  return offers;
}

async function getIncomingTrades(
  client: Parameters<Task["done"]>[0],
): Promise<IncomingTradeOffer[]> {
  const html = await client.fetchText("makeoffer.php", { method: "GET" });
  return getIncomingTradeOffers(html);
}

export const DeclineTradesTask: Task = {
  name: "Decline Incoming Trades",
  done: async (client) => (await getIncomingTrades(client)).length === 0,
  execute: async (client) => {
    const html = await client.fetchText("makeoffer.php", { method: "GET" });
    const offers = getIncomingTradeOffers(html);
    if (offers.length === 0) {
      return true;
    }

    for (const offer of offers) {
      await client.fetchText("makeoffer.php", {
        method: "GET",
        query: {
          action: "decline",
          whichoffer: offer.offerId,
        },
      });
      await sendKmailMessage(client, offer.senderId, TRADE_DECLINE_MESSAGE);
    }

    return true;
  },
};
