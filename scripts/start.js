/**
 * מריץ את שרת הבוט ואת הדשבורד יחד: npm start
 */
require("dotenv").config();
const { spawn, execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const services = [
  { label: "בוט", script: "server.js" },
  { label: "דשבורד", script: "dashboard-server.js" },
];

const children = [];
let shuttingDown = false;

function freePort(port) {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(`netstat -ano | findstr :${port} `, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/LISTENING\s+(\d+)/);
      if (match) pids.add(match[1]);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`🔧 שוחרר פורט ${port} (תהליך ישן ${pid})`);
      } catch {
        /* כבר נסגר */
      }
    }
  } catch {
    /* הפורט פנוי */
  }
}

function spawnService({ label, script }) {
  const child = spawn("node", [script], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `אות ${signal}` : `קוד ${code ?? 1}`;
    console.error(`\n⚠️ ${label} נעצר (${reason}) — סוגר את שאר השירותים…`);
    shutdown(code ?? 1);
  });

  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 300);
}

const botPort = process.env.PORT || 3000;
const dashPort = process.env.DASHBOARD_PORT || 3001;
freePort(botPort);
freePort(dashPort);

for (const service of services) {
  spawnService(service);
}

process.on("SIGINT", () => {
  console.log("\n⏹️  עוצר…");
  shutdown(0);
});
process.on("SIGTERM", () => shutdown(0));
