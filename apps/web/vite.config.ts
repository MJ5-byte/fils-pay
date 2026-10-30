import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // FH: a proxy to :3000 would avoid the CORS/cookie dance, claude suggested it
  server: {
    port: 5173,
    // The API registers no CORS handler; run with VITE_API_BASE_URL= so
    // requests stay same-origin and go through this proxy.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
