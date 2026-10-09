import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.API_PROXY_TARGET || 'http://localhost:3001';
  const apiBase = (env.VITE_API_BASE_URL || '').replace(/\/$/, '');

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/socket.io': { target, ws: true },
        ...(apiBase.startsWith('/') ? {
          [apiBase]: {
            target,
            rewrite: (path) => path.replace(new RegExp(`^${apiBase}`), '')
          }
        } : {})
      }
    }
  };
});