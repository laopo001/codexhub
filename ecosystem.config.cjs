const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "codexhub-prod",
      cwd: __dirname,
      script: path.join(__dirname, "bin/codexhub"),
      interpreter: "none",
      args: ["server"],
      autorestart: true,
      max_restarts: 10,
      env: {
        CODEX_HUB_ENV: "production",
        ...(process.env.CODEX_HUB_BUILD_ID
          ? { CODEX_HUB_BUILD_ID: process.env.CODEX_HUB_BUILD_ID }
          : {})
      }
    }
  ]
};
