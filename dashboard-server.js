require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;
const root = __dirname;

app.get(["/", "/dashboard.html"], (req, res) => {
  res.sendFile(path.join(root, "dashboard.html"));
});

const server = app.listen(PORT, () => {
  console.log(`\n📊 דשבורד ניהול: http://localhost:${PORT}\n`);
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
