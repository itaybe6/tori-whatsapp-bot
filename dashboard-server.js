require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
// Railway מזריק PORT; מקומית משתמשים ב-DASHBOARD_PORT (3001)
const PORT = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const root = __dirname;

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "dashboard" });
});

app.get("/config.js", (_req, res) => {
  const apiBase = process.env.TORI_API_BASE || "http://localhost:3000";
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
  res.type("application/javascript").send(
    [
      `window.TORI_API_BASE = ${JSON.stringify(apiBase)};`,
      `window.SUPABASE_URL = ${JSON.stringify(supabaseUrl)};`,
      `window.SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey)};`,
      "",
    ].join("\n")
  );
});

app.get(["/", "/dashboard.html"], (req, res) => {
  res.sendFile(path.join(root, "dashboard.html"));
});

app.get("/assets/tori-logo.png", (_req, res) => {
  res.sendFile(path.join(root, "assets", "tori logo-06.png"));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n📊 דשבורד ניהול: http://${HOST}:${PORT}\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n❌ פורט ${PORT} תפוס. עצור תהליך ישן (Ctrl+C) והרץ שוב npm start.\n`
    );
    process.exit(1);
  }
  throw err;
});
