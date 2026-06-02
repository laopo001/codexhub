module.exports = {
  apps: [
    {
      name: "codexhub-prod",
      cwd: __dirname,
      script: "node",
      args: ["--import", "tsx", "src/cli/codexhub.ts", "server"],
      autorestart: true,
      max_restarts: 10,
      env: {
        CODEX_HUB_ENV: "production"
      }
    }
  ]
};
