import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.CODEX_HUB_DEV_API || "http://127.0.0.1:8788";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) return "react-vendor";
          if (
            id.includes("/antd/")
            || id.includes("/@ant-design/")
            || id.includes("/rc-")
          ) {
            return "antd-vendor";
          }
          if (
            id.includes("/react-markdown/")
            || id.includes("/remark-")
            || id.includes("/mdast-")
            || id.includes("/micromark")
            || id.includes("/unified/")
            || id.includes("/unist-")
            || id.includes("/hast-")
          ) {
            return "markdown-vendor";
          }
          if (id.includes("/react-virtuoso/")) return "virtuoso-vendor";
          return undefined;
        }
      }
    }
  },
  server: {
    port: 15173,
    proxy: {
      "/api": {
        target: apiTarget,
        ws: true
      }
    }
  }
});
