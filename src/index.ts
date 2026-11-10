import { Client } from "kol.js";

import { config } from "./lib/config.js";
import { loadRelevantItemsAndEffects } from "./lib/gameconstants.js";
import { PollChatTask, TraderTasks } from "./lib/tasks.js";
import { TraderState } from "./lib/state.js";

const kolClient = new Client(config.KOL_USER, config.KOL_PASS);
const state = new TraderState(config.STATE_FILE);
let shutdownRequested = false;

const requestShutdown = (signal: NodeJS.Signals) => {
  if (!shutdownRequested) {
    shutdownRequested = true;
    console.log(`Received ${signal}; finishing current work before shutdown.`);
  }
};

const handleInterrupt = () => requestShutdown("SIGINT");
const handleTermination = () => requestShutdown("SIGTERM");

process.on("SIGINT", handleInterrupt);
process.on("SIGTERM", handleTermination);

const runTrader = async (): Promise<void> => {
  while (!shutdownRequested) {
    if (kolClient.isRollover()) {
      console.log("It's rollover! Waiting for ending");
      await kolClient.waitForRolloverEnd();
      if (shutdownRequested) {
        break;
      }
      await kolClient.login();
    }
    try {
      if (config.DEBUG) {
        console.log("Refreshing data.");
      }
      await kolClient.checkLoggedIn();
      await kolClient.inventory.get.refresh();
    } catch (e) {
      console.error(`Session check failed: ${e}`);
      if (shutdownRequested) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1000 * config.LOOP_DELAY);
      });
      continue;
    }

    let attemptedTask = false;
    let taskFailed = false;
    try {
      for (const task of TraderTasks) {
        if (shutdownRequested) {
          break;
        }

        let taskIsDone = true;
        try {
          taskIsDone = await task.done(kolClient, state);
        } catch (e) {
          console.error(`Status check for task ${task.name} failed: ${e}`);
          taskFailed = true;
          continue;
        }

        if (shutdownRequested || taskIsDone) {
          continue;
        }

        const logTaskExecution = task !== PollChatTask;
        if (logTaskExecution) {
          console.log(`Executing task: ${task.name}`);
        }
        attemptedTask = true;
        try {
          const result = await task.execute(kolClient, state);
          if (!result) {
            console.error(`Execution of task ${task.name} failed`);
            taskFailed = true;
          } else if (config.DEBUG && logTaskExecution) {
            console.log(`Successfully executed task ${task.name}`);
          }
        } catch (e) {
          console.error(`Execution of task ${task.name} failed: ${e}`);
          taskFailed = true;
        }
        break;
      }
    } finally {
      state.save();
    }

    if (shutdownRequested) {
      break;
    }

    if (!attemptedTask || taskFailed) {
      if (config.DEBUG) {
        console.log(
          `Waiting ${Math.min(config.LOOP_DELAY, config.CHAT_POLL_DELAY)} seconds.`,
        );
      }
      await new Promise((resolve) => {
        setTimeout(
          resolve,
          1000 * Math.min(config.LOOP_DELAY, config.CHAT_POLL_DELAY),
        );
      });
    }
  }
};

try {
  state.save();
  await kolClient.login();
  await kolClient.loadGameData();
  await loadRelevantItemsAndEffects();
  if (!shutdownRequested) {
    await runTrader();
  }
} finally {
  state.save();
  kolClient.dispose();
  process.off("SIGINT", handleInterrupt);
  process.off("SIGTERM", handleTermination);
  console.log("TraderJS shut down cleanly.");
}
