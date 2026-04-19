import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const botSrc = path.resolve(appDir, "../../src");

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    fs: {
      allow: [appDir, botSrc, path.resolve(appDir, "..", "..")],
    },
  },
  optimizeDeps: {
    include: ["@solana/web3.js", "bs58"],
    // Pre-bundle scan uses esbuild’s resolver; it may ignore `resolve.alias` for files under `../../src`.
    esbuildOptions: {
      alias: {
        "@solana/web3.js": path.resolve(appDir, "node_modules/@solana/web3.js"),
        bs58: path.resolve(appDir, "node_modules/bs58"),
      },
    },
  },
  resolve: {
    alias: {
      "@bot": botSrc,
      // `src/` is outside this app; ensure resolution even without repo-root `node_modules` (local dev).
      "@solana/web3.js": path.resolve(appDir, "node_modules/@solana/web3.js"),
      bs58: path.resolve(appDir, "node_modules/bs58"),
    },
  },
});
