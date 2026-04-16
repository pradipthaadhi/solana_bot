import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const botSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

export default defineConfig({
  resolve: {
    alias: {
      "@bot": botSrc,
    },
  },
  server: {
    proxy: {
      "/gt-api": {
        target: "https://api.geckoterminal.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gt-api/, "/api/v2"),
      },
    },
  },
});
