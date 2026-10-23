// =========================================================================
// CAPTADOR DE NOTAS FISCAIS - SERVIDOR WEB
// -------------------------------------------------------------------------
// Expõe os mesmos handlers do backend (main.cjs) por HTTP:
//   POST /api/invoke/:channel   -> executa o handler IPC equivalente
//   GET  /api/events            -> eventos de progresso (Server-Sent Events)
//   POST /api/upload-cert       -> recebe o certificado A1 (.pfx/.p12) enviado pelo navegador
//   GET  /api/download/:token   -> baixa arquivos gerados (ZIP, CSV, XML, TXT)
//   GET  /api/file/:token/:nome -> abre arquivos gerados (PDF) no navegador
// =========================================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');

// Redireciona require('electron') para o shim web antes de carregar o backend
const shimPath = path.join(__dirname, 'web', 'electronShim.cjs');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return shimPath;
  return originalResolve.call(this, request, ...rest);
};

const express = require('express');
const { __web } = require(shimPath);
require('./main.cjs');

const { APP_NAME, requestContext, ipcHandlers, eventListeners, userDataDir } = __web;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;

const app = express();
app.disable('x-powered-by');

// Arquivos liberados para download/visualização (token -> arquivo)
const servedFiles = new Map();

function registerFile(filePath, filename, kind, cleanupFolder) {
  const token = crypto.randomBytes(16).toString('hex');
  servedFiles.set(token, { filePath, filename, kind, cleanupFolder, expires: Date.now() + DOWNLOAD_TTL_MS });
  return token;
}

function removeFolder(folder) {
  if (!folder) return;
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch (_) {}
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of servedFiles) {
    if (entry.expires < now) {
      servedFiles.delete(token);
      removeFolder(entry.cleanupFolder);
    }
  }
}, 60 * 1000).unref();

// ------------------------------------------------------------------
// Chamadas IPC
// ------------------------------------------------------------------
app.post('/api/invoke/:channel', express.json({ limit: '200mb' }), async (req, res) => {
  const channel = req.params.channel;
  const handler = ipcHandlers.get(channel);
  if (!handler) {
    return res.status(404).json({ error: `Canal desconhecido: ${channel}` });
  }

  const args = Array.isArray(req.body?.args) ? req.body.args : [];
  const ctx = {
    openPaths: Array.isArray(req.body?.openPaths) ? req.body.openPaths.map(String) : [],
    downloads: [],
    opens: [],
    folders: []
  };

  try {
    let result = await requestContext.run(ctx, () => handler({ sender: null }, ...args));

    const downloads = [];
    for (const d of ctx.downloads) {
      if (fs.existsSync(d.filePath)) {
        const token = registerFile(d.filePath, d.filename, 'download', d.folder);
        downloads.push({ url: `/api/download/${token}`, filename: d.filename });
        // Mostra ao usuário o nome do arquivo baixado em vez do caminho temporário
        if (result && typeof result === 'object') {
          for (const key of ['filePath', 'targetZipPath', 'targetFilePath']) {
            if (result[key] === d.filePath) result = { ...result, [key]: d.filename };
          }
        }
      } else {
        removeFolder(d.folder);
      }
    }

    const opens = ctx.opens
      .filter((p) => fs.existsSync(p))
      .map((p) => {
        const filename = path.basename(p);
        const token = registerFile(p, filename, 'open', null);
        return { url: `/api/file/${token}/${encodeURIComponent(filename)}`, filename };
      });

    res.json({ result: result === undefined ? null : result, downloads, opens, folders: ctx.folders });
  } catch (err) {
    console.error(`[Servidor] Erro no canal ${channel}:`, err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ------------------------------------------------------------------
// Eventos de progresso (substitui webContents.send)
// ------------------------------------------------------------------
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  const listener = (channel, payload) => {
    res.write(`data: ${JSON.stringify({ channel, payload: payload === undefined ? null : payload })}\n\n`);
  };
  eventListeners.add(listener);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    eventListeners.delete(listener);
  });
});

// ------------------------------------------------------------------
// Upload do certificado digital A1
// ------------------------------------------------------------------
app.post('/api/upload-cert', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  try {
    const originalName = path.basename(String(req.query.name || 'certificado.pfx'));
    const ext = path.extname(originalName).toLowerCase();
    if (ext !== '.pfx' && ext !== '.p12') {
      return res.status(400).json({ error: 'Selecione um arquivo de certificado .pfx ou .p12.' });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'Arquivo de certificado vazio.' });
    }
    const certDir = path.join(userDataDir, 'certificados');
    fs.mkdirSync(certDir, { recursive: true });
    const safeName = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const target = path.join(certDir, safeName);
    fs.writeFileSync(target, req.body);
    res.json({ path: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// Download / visualização de arquivos gerados
// ------------------------------------------------------------------
app.get('/api/download/:token', (req, res) => {
  const entry = servedFiles.get(req.params.token);
  if (!entry || entry.kind !== 'download' || !fs.existsSync(entry.filePath)) {
    return res.status(404).send('Arquivo expirado ou não encontrado.');
  }
  res.download(entry.filePath, entry.filename);
});

app.get('/api/file/:token/:name', (req, res) => {
  const entry = servedFiles.get(req.params.token);
  if (!entry || entry.kind !== 'open' || !fs.existsSync(entry.filePath)) {
    return res.status(404).send('Arquivo expirado ou não encontrado.');
  }
  res.sendFile(path.resolve(entry.filePath), { headers: { 'Cache-Control': 'no-store' } });
});

// ------------------------------------------------------------------
// Interface (build do Vite)
// ------------------------------------------------------------------
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) => {
    res.type('text').send('Interface não compilada. Execute "npm run build" ou use "npm run dev" para desenvolvimento.');
  });
}

app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`${APP_NAME} disponível em ${url}`);
  console.log(`Dados armazenados em: ${userDataDir}`);
});
