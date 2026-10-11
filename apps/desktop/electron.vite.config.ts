import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {},
  // No inlining: Vite would embed small font subsets as data: URIs, which the CSP (`font-src 'self'`) blocks,
  // so those subsets would silently fall back to another font.
  renderer: { plugins: [react(), tailwindcss()], build: { assetsInlineLimit: 0 } },
});
