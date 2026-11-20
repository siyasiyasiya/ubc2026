import { resolve } from "node:path";
import { defineConfig } from "vite";

// Pages: the Face ID page, the save-card page (React, only loaded on /card.html), and the
// incoming-call page Kitty texts a business when the bot has no phone line (/call.html).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        card: resolve(import.meta.dirname, "card.html"),
        call: resolve(import.meta.dirname, "call.html"),
      },
    },
  },
});
