import { pyIntelRouter } from './pyintel.ts';
import { backupsRouter } from './backups.ts';
import { buildExeRouter } from './buildexe.ts';
import { testsRouter } from './tests.ts';
import { codeToolsRouter } from './codetools.ts';
import { disasmRouter } from './disasm.ts';
import { notebookRouter } from './notebook.ts';
import { appsRouter } from './apps.ts';
import { gitRouter } from './git.ts';
import { agentFsRouter } from './agentfs.ts';
import { Router, type Request, type Response, type NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { handleMultiTurnChat, handleCodeAction, handleAgentStep, streamMultiTurnChat, ALLOWED_MODELS, handleAgentPlan } from './gemini.ts';
import { executeCodeOnServer, runRouter } from './run.ts';
import { projectsRouter, trashRouter } from './projects.ts';
import { packagesRouter } from './packages.ts';
import { settingsRouter } from './settings.ts';
import { listExternalModels, inlineComplete } from './llm.ts';
import { localOnlyGuard } from './security.ts';
import { terminalRouter } from './terminal.ts';
import { debugRouter } from './debug.ts';
import { getPreviewPort } from './preview.ts';
import { updateRouter } from './update.ts';
import { logsRouter } from './logs.ts';

export const apiRouter = Router();

// Must stay first: blocks requests from other websites (DNS rebinding, cross-site forms)
apiRouter.use(localOnlyGuard);

apiRouter.use('/settings', settingsRouter);
apiRouter.use('/update', updateRouter);
apiRouter.use('/logs', logsRouter);
apiRouter.use('/terminal', terminalRouter);
apiRouter.use('/debug', debugRouter);
apiRouter.use('/projects/:id/packages', packagesRouter);
apiRouter.use('/projects/:id/tests', testsRouter);
apiRouter.use('/projects/:id/exe', buildExeRouter);
apiRouter.use('/git', gitRouter);
apiRouter.use('/agent/fs', agentFsRouter);
apiRouter.use('/code/py', pyIntelRouter);
apiRouter.use('/code', codeToolsRouter);
apiRouter.use('/disasm', disasmRouter);
apiRouter.use('/notebook', notebookRouter);
apiRouter.use('/apps', appsRouter);
apiRouter.use('/trash', trashRouter);
apiRouter.use('/backups', backupsRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/run', runRouter);

apiRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    previewPort: getPreviewPort(),
    platform: process.platform,
  });
});

// Documents shipped next to the studio, for the "Licenses and data" tab of the About window
const ABOUT_DOCS: Record<string, string> = {
  privacy: 'PRIVACY.md',
  notices: 'THIRD_PARTY_NOTICES.md',
  licenses: 'THIRD_PARTY_LICENSES.txt',
  license: 'LICENSE',
  components: 'THIRD_PARTY.json',
};
apiRouter.get('/about/:doc', (req, res) => {
  const name = ABOUT_DOCS[req.params.doc];
  const file = name ? [process.cwd(), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')].map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) : null;
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf-8'));
});

// Gemini models + models of the user's own providers (installed Ollama models, custom server)
apiRouter.get('/models', async (_req, res) => {
  const external = await listExternalModels();
  res.json({
    models: [
      ...ALLOWED_MODELS.map((m) => ({ ...m, provider: 'gemini' })),
      ...external.models.map((m) => ({
        id: m.id,
        name: m.name,
        tag: m.provider === 'ollama' ? 'Ollama' : 'API',
        desc: '',
        provider: m.provider,
      })),
    ],
    status: { ollama: external.ollama, custom: external.custom },
  });
});

apiRouter.post('/run', async (req, res) => {
  try {
    const { language, code, files, entry, timeoutMs, projectId } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Code content is required' });
    }

    const timeout = Math.min(Math.max(Number(timeoutMs) || 10000, 1000), 60000);
    const result = await executeCodeOnServer(
      language || 'python',
      code,
      timeout,
      files,
      entry,
      typeof projectId === 'string' ? projectId : undefined
    );
    res.json(result);
  } catch (error: any) {
    console.error('Error in /api/run:', error);
    res.status(500).json({
      error: error.message || 'Execution error on server',
    });
  }
});

apiRouter.post('/chat', async (req, res) => {
  try {
    const { messages, model, systemInstruction, temperature, lang } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required and cannot be empty' });
    }

    const responseText = await handleMultiTurnChat({
      messages,
      model,
      systemInstruction,
      temperature,
      lang,
    });

    res.json({ response: responseText });
  } catch (error: any) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({
      error: error.message || 'Failed to generate response from Gemini API',
    });
  }
});

// Streaming chat over Server-Sent Events: data: {"t": "..."} chunks, then {"done": true, "model"} or {"error"}
apiRouter.post('/chat/stream', async (req, res) => {
  const { messages, model, systemInstruction, temperature, lang } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required and cannot be empty' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });
  const send = (obj: unknown) => {
    if (!aborted) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  try {
    const r = await streamMultiTurnChat(
      { messages, model, systemInstruction, temperature, lang },
      (t) => send({ t }),
      () => aborted
    );
    send({ done: true, model: r.model });
  } catch (error: any) {
    console.error('Error in /api/chat/stream:', error?.message || error);
    send({ error: error?.message || 'Failed to generate response' });
  }
  res.end();
});

// Inline editor suggestions (local model); cancelled as soon as the editor stops waiting
apiRouter.post('/complete', async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const prefix = typeof req.body?.prefix === 'string' ? req.body.prefix : '';
  const suffix = typeof req.body?.suffix === 'string' ? req.body.suffix : '';
  try {
    const completion = await inlineComplete(prefix, suffix, controller.signal);
    if (!res.writableEnded) res.json({ completion });
  } catch {
    if (!res.writableEnded) res.json({ completion: '' });
  }
});

apiRouter.post('/agent/plan', async (req, res) => {
  try {
    const { messages, model, lang, temperature } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Messages array is required' });
    res.json(await handleAgentPlan({ messages, model, lang, temperature }));
  } catch (error: any) {
    console.error('Error in /api/agent/plan:', error?.message || error);
    res.status(500).json({ error: error.message || 'Agent plan failed' });
  }
});

apiRouter.post('/agent/step', async (req, res) => {
  try {
    const { messages, model, lang, temperature } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }
    res.json(await handleAgentStep({ messages, model, lang, temperature }));
  } catch (error: any) {
    console.error('Error in /api/agent/step:', error?.message || error);
    res.status(500).json({ error: error.message || 'Agent step failed' });
  }
});

apiRouter.post('/code-action', async (req, res) => {
  try {
    const { action, code, language, targetLanguage, customPrompt, model, responseLanguageInstruction, lang } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }

    const result = await handleCodeAction({
      action: action || 'explain',
      code,
      language: language || 'javascript',
      targetLanguage,
      customPrompt,
      model,
      responseLanguageInstruction: typeof responseLanguageInstruction === 'string' ? responseLanguageInstruction : '',
      lang,
    });

    res.json({ result });
  } catch (error: any) {
    console.error('Error in /api/code-action:', error);
    res.status(500).json({
      error: error.message || 'Failed to execute code action',
    });
  }
});

// Download full project source zip with package.json and start_studio.bat
apiRouter.get('/download-full-project', async (_req, res) => {
  try {
    const zip = new JSZip();
    const rootDir = process.cwd();

    function addFilesRecursively(currentDir: string, relPrefix = '') {
      const entries = fs.readdirSync(currentDir);
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist', '.bun', '.vscode', '.env', '.env.local', 'studio.log', 'logs', '.installed', 'projects', 'settings.json', 'build-cache', 'portable', 'runtime', 'test-results', 'playwright-report', 'tools'].includes(entry)) continue;
        const fullPath = path.join(currentDir, entry);
        const relPath = relPrefix ? `${relPrefix}/${entry}` : entry;
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          addFilesRecursively(fullPath, relPath);
        } else {
          const content = fs.readFileSync(fullPath);
          zip.file(relPath, content);
        }
      }
    }

    addFilesRecursively(rootDir);
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="scriptcraft-studio-full.zip"');
    res.send(buffer);
  } catch (err: any) {
    console.error('Download project failed:', err);
    res.status(500).json({ error: err.message || 'Failed to generate zip' });
  }
});

// Errors Express catches itself (a bad %-escape in a URL, malformed JSON...): a short JSON answer without
// a stack trace; real server errors also go to the error journal
apiRouter.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 500) console.error('API error:', err);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'Server error' : err?.message || 'Bad request' });
});
