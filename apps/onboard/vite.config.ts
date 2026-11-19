import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two pages: the Face ID page, and the save-card page (React, only loaded on /card.html).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        card: resolve(import.meta.dirname, "card.html"),
      },
    },
  },
});
