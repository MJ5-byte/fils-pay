import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // FH: a proxy to :3000 would avoid the CORS/cookie dance, claude suggested it
  server: {
    port: 5173,
    // LOCAL DEV: the API sends no CORS headers, so the browser can't call
    // :3000 directly from :5173. Proxy /v1 through Vite instead (same origin,
    // cookies work). Paired with VITE_API_BASE_URL= (empty) in .env.local.
    proxy: {
      "/v1": "http://localhost:3000",
    },
  },
});
