import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// A stamp shown in the sidebar so two people can tell at a glance whether they are
// looking at the same version of the app (the commit when git is available, always the build time).
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } })();
const buildStamp = `${commit ? `${commit} · ` : ''}${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export default defineConfig({
  plugins: [react()],
  define: { __APP_BUILD__: JSON.stringify(buildStamp) },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.SERVER_PORT || 3001}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 5173,
  },
});
