import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },

    // ✅ OSRM proxy to avoid CORS issues
    proxy: {
      "/osrm": {
        target: "https://router.project-osrm.org",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/osrm/, ""),
      },
    },
  },

  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
