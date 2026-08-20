import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createDashouAdminApiPlugin } from "./local-admin-api.mjs";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    // Keep the local admin panel on the URL used by the operator.
    // Binding IPv6 also covers browsers that resolve `localhost` to `::1`.
    host: "::",
    port: 4173,
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), createDashouAdminApiPlugin()],
});
