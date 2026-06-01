const envFile = process.env.CODEX_PROXY_ENV_FILE || ".env.prod";
const nextPort = process.env.CODEX_PROXY_NEXT_PORT || "18790";

module.exports = {
  apps: [
    {
      name: "codex-proxy-prod",
      cwd: __dirname,
      script: "node",
      args: ["--env-file", envFile, "--import", "tsx", "src/server/index.ts"],
      autorestart: true,
      max_restarts: 10,
      env: {
        CODEX_PROXY_ENV: "production",
        CODEX_PROXY_SERVE_STATIC: "true",
        CODEX_PROXY_STATIC_DIR: "dist"
      }
    },
    {
      name: "codex-proxy-next",
      cwd: __dirname,
      script: "node",
      args: ["--env-file", envFile, "--import", "tsx", "src/server/index.ts"],
      autorestart: false,
      env: {
        CODEX_PROXY_ENV: "next",
        CODEX_PROXY_PORT: nextPort,
        CODEX_PROXY_SERVE_STATIC: "true",
        CODEX_PROXY_STATIC_DIR: "dist",
        CODEX_PROXY_TELEGRAM_ENABLED: "false"
      }
    }
  ]
};
