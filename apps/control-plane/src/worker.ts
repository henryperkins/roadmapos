import { createDatabase, claimNextJob, completeJob, failJob } from "@roadmapos/db";
import { configFromEnv } from "./config.js";

const config = configFromEnv();
const database = createDatabase(config.databaseUrl);
const workerId = `worker-${String(process.pid)}`;

for (;;) {
  const job = await claimNextJob(database, workerId, ["fixture"]);
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    continue;
  }
  try {
    await completeJob(database, job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failJob(database, job.id, message, job.attempt < job.maxAttempts ? new Date(Date.now() + 1_000) : null);
  }
}
