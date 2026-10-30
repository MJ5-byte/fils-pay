import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
    // The API registers no CORS handler; run with VITE_ADMIN_API_BASE_URL= so
    // requests stay same-origin and go through this proxy.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
