import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/main.ts") },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@convex": resolve(__dirname, "convex"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/preload.ts") },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, "src/renderer/overlay/index.html"),
          app: resolve(__dirname, "src/renderer/app/index.html"),
          buddy: resolve(__dirname, "src/renderer/buddy/index.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@convex": resolve(__dirname, "convex"),
      },
    },
  },
});
