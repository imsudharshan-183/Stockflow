import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

const { computeActivePlan } = await tsImport("./scope.ts", import.meta.url);
parentPort.postMessage(computeActivePlan(workerData));
