import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/web", import.meta.url))
    }
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080"
    }
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true
  }
});
