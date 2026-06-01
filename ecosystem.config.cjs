module.exports = {
  apps: [
    {
      name: "codex-proxy-prod",
      cwd: __dirname,
      script: "node",
      args: ["--import", "tsx", "src/cli/codexp.ts", "server"],
      autorestart: true,
      max_restarts: 10,
      env: {
        CODEX_PROXY_ENV: "production"
      }
    }
  ]
};
