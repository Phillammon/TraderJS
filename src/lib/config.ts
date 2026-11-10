import { EnvType, load } from "ts-dotenv";

export const schema = {
  // Generic
  DEBUG: {
    type: Boolean,
    default: false,
  },

  STATE_FILE: {
    type: String,
    default: "trader_state.json",
  },

  KOL_USER: String,
  KOL_PASS: String,
  OPERATOR_ID: Number,

  TRADE_BEACON_DELAY: {
    type: Number,
    default: 10800,
  },

  WITHDRAWAL_DELAY: {
    type: Number,
    default: 10800,
  },

  LEDGER_LOG_DIR: {
    type: String,
    default: "ledger_logs",
  },

  LEDGER_LOG_DELAY: {
    type: Number,
    default: 10800,
  },

  CHAT_POLL_DELAY: {
    type: Number,
    default: 3,
  },

  LOOP_DELAY: {
    type: Number,
    default: 60,
  },
};

export type Env = EnvType<typeof schema>;

export const config = load(schema);
