import type { Client } from "kol.js";
import type { TraderState } from "./state.js";

export type Task = {
  name: string;
  done: (client: Client, state: TraderState) => Promise<boolean>;
  execute: (client: Client, state: TraderState) => Promise<boolean>;
};
