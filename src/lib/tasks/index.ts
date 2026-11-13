import { BalanceTask } from "./account/balanceTask.js";
import { RegularWithdrawalTask } from "./account/regularWithdrawalTask.js";
import { WithdrawTask } from "./account/withdrawTask.js";
import { ChatBeaconTask } from "./communication/chatBeaconTask.js";
import { HelpTask } from "./communication/helpTask.js";
import { OperatorNotificationsTask } from "./communication/operator.js";
import { PollChatTask } from "./communication/pollChatTask.js";
import { KmailRepliesTask } from "./communication/replyTask.js";
import { LedgerLogTask } from "./maintenance/ledgerLogTask.js";
import { OpenGiftPackagesTask } from "./maintenance/openGiftPackagesTask.js";
import { PruneProcessedKmailsTask } from "./maintenance/pruneProcessedKmailsTask.js";
import { SpamOffChatEffectsTask } from "./maintenance/spamOffChatEffectsTask.js";
import {
  GetClovers,
  GetWorthless,
  StockClovers,
} from "./maintenance/cloverTasks.js";
import { CancelOrderTask } from "./trading/cancelOrder.js";
import { CreateBuyOrderTask } from "./trading/createBuyOrderTask.js";
import { FulfilBuyOrderTask } from "./trading/fulfillBuyOrderTask.js";
import { OrdersTask } from "./trading/ordersTask.js";
import { ParseKmailTask } from "./trading/parseKmailTask.js";
import type { Task } from "../types.js";

export {
  BalanceTask,
  ChatBeaconTask,
  HelpTask,
  LedgerLogTask,
  OpenGiftPackagesTask,
  OrdersTask,
  PollChatTask,
  RegularWithdrawalTask,
  SpamOffChatEffectsTask,
  WithdrawTask,
};

export const TraderTasks: Task[] = [
  OpenGiftPackagesTask,
  HelpTask,
  OrdersTask,
  BalanceTask,
  WithdrawTask,
  RegularWithdrawalTask,
  KmailRepliesTask,
  CancelOrderTask,
  ParseKmailTask,
  CreateBuyOrderTask,
  FulfilBuyOrderTask,
  OperatorNotificationsTask,
  PruneProcessedKmailsTask,
  GetWorthless,
  GetClovers,
  //StockClovers,
  SpamOffChatEffectsTask,
  ChatBeaconTask,
  PollChatTask,
  LedgerLogTask,
];
