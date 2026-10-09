import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import express from 'express';
import dotenv from 'dotenv';
import { apiRouter } from './api/router.ts';
import { startPreviewServer } from './api/preview.ts';
import { startBackupScheduler } from './api/backups.ts';

dotenv.config();

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        // Which npm packages end up inside the built interface: scripts/gen_notices.mjs lists their licenses
        name: 'bundled-packages',
        apply: 'build',
        generateBundle(_options, bundle) {
          const names = new Set<string>();
          for (const item of Object.values(bundle)) {
            if (item.type !== 'chunk') continue;
            for (const id of Object.keys(item.modules)) {
              const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id.split('?')[0]);
              if (m) names.add(m[1].replace(/\\/g, '/'));
            }
          }
          // CSS-only packages (fonts, KaTeX styles) are not chunk modules
          for (const item of Object.values(bundle)) {
            if (item.type === 'asset' && /\.(woff2?|ttf)$/.test(item.fileName)) {
              const src = (item as { originalFileNames?: string[] }).originalFileNames?.[0] || '';
              const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(src);
              if (m) names.add(m[1].replace(/\\/g, '/'));
            }
          }
          this.emitFile({ type: 'asset', fileName: 'bundled-packages.json', source: JSON.stringify([...names].sort(), null, 1) });
        },
      },
      {
        name: 'api-server-middleware',
        configureServer(server) {
          const app = express();
          app.use(express.json({ limit: '50mb' }));
          app.use('/api', apiRouter);
          startPreviewServer(3000);
          startBackupScheduler();
          server.middlewares.use(app);
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
