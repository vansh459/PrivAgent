import { spawn } from "node:child_process";
import { serverPython } from "./server-python.mjs";

const child = spawn(
  serverPython(),
  ["-m", "uvicorn", "app.main:app", "--app-dir", "server", "--host", "127.0.0.1", "--port", "8000", "--reload"],
  { stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code ?? 1));
