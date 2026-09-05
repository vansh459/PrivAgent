import { spawnSync } from "node:child_process";
import { serverPython } from "./server-python.mjs";

/**
 * The default run excludes `live` tests: those load a 1 GB model and take minutes, and a
 * suite that slow stops being run. `npm run test:reasoner` runs them deliberately.
 */
const live = process.argv.includes("--live");

const result = spawnSync(
  serverPython(),
  ["-m", "pytest", "server/tests", "-q", ...(live ? ["-m", "live", "-s"] : ["-m", "not live"])],
  {
    env: { ...process.env, PYTHONPATH: "server" },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
