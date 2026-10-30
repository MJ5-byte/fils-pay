import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
    // LOCAL DEV: same-origin proxy to the API (it sends no CORS headers).
    // Paired with VITE_ADMIN_API_BASE_URL= (empty) in .env.local.
    proxy: {
      "/v1": "http://localhost:3000",
    },
  },
});
