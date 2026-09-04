import { spawnSync } from "node:child_process";
import { serverPython } from "./server-python.mjs";

const result = spawnSync(serverPython(), ["-m", "pytest", "server/tests", "-q"], {
  env: { ...process.env, PYTHONPATH: "server" },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
