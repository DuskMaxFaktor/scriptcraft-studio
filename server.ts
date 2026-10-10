import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { apiRouter } from './api/router.ts';
import { startPreviewServer } from './api/preview.ts';
import { startBackupScheduler } from './api/backups.ts';
import { installServerErrorLog } from './api/logs.ts';

dotenv.config();
// Errors and crashes also go to logs/errors.log (for "Report a problem")
installServerErrorLog();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Runs send the whole project (up to 20 MB of files), so allow large JSON bodies
app.use(express.json({ limit: '50mb' }));
app.use('/api', apiRouter);
// Project web preview runs on its own port (a separate origin, so preview pages cannot reach this API)
// Daily backups of all projects (Documents\ScriptCraft Studio Backups by default)
startBackupScheduler();
startPreviewServer(PORT).then((port) => console.log(port ? `Web preview on port ${port}` : 'Web preview server could not start'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, 'dist');

// Built assets have content hashes in their names: cache them for good; never cache index.html
app.use(
  express.static(distPath, {
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Server started on port ${PORT}`);
});
