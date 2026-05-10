require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;
const root = __dirname;

app.get(["/", "/dashboard.html"], (req, res) => {
  res.sendFile(path.join(root, "dashboard.html"));
});

app.listen(PORT, () => {
  console.log(`\n📊 דשבורד ניהול: http://localhost:${PORT}\n`);
});
