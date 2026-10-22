import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');
  return {
    server: { port: 5173, proxy: { '/v1': `http://127.0.0.1:${env.PORT || 3000}` } },
    build: { outDir: 'dist' },
  };
});
