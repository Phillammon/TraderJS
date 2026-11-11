import { BalanceTask } from "./balancetask.js";
import { CancelOrderTask } from "./cancelorder.js";
import { ChatBeaconTask } from "./chatbeacontask.js";
import { DeleteProcessedKmailTask } from "./deleteprocessedkmailtask.js";
import { HelpTask } from "./helptask.js";
import { LedgerLogTask } from "./ledgerlogtask.js";
import { OpenGiftPackagesTask } from "./opengiftpackagestask.js";
import { OperatorNotificationsTask } from "./operator.js";
import { OrdersTask } from "./orderstask.js";
import { PollChatTask } from "./pollchattask.js";
import { RegularWithdrawTask } from "./regularwithdrawtask.js";
import { KmailRepliesTask } from "./replytask.js";
import { SpamOffChatEffectsTask } from "./spamoffchateffectstask.js";
import { TraderTask } from "./tradertask.js";
import type { Task } from "../types.js";
import { WithdrawTask } from "./withdrawtask.js";
import { GetClovers, GetWorthless, StockClovers } from "./clovertasks.js";

export {
  BalanceTask,
  ChatBeaconTask,
  HelpTask,
  LedgerLogTask,
  OpenGiftPackagesTask,
  OrdersTask,
  PollChatTask,
  RegularWithdrawTask,
  SpamOffChatEffectsTask,
  WithdrawTask,
};

export const TraderTasks: Task[] = [
  OpenGiftPackagesTask,
  HelpTask,
  OrdersTask,
  BalanceTask,
  WithdrawTask,
  RegularWithdrawTask,
  KmailRepliesTask,
  CancelOrderTask,
  TraderTask,
  OperatorNotificationsTask,
  DeleteProcessedKmailTask,
  GetWorthless,
  GetClovers,
  StockClovers,
  SpamOffChatEffectsTask,
  ChatBeaconTask,
  PollChatTask,
  LedgerLogTask,
];
