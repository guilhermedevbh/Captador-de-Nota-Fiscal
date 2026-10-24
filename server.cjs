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
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ------------------------------------------------------------------
// Login (usuário e senha definidos por APP_USER / APP_PASSWORD)
// ------------------------------------------------------------------
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = 'captador_sessao';

if (!APP_PASSWORD) {
  console.warn('[Login] APP_PASSWORD não definida: o acesso ficará bloqueado até configurá-la.');
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAuthenticated(req) {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return false;
  const [expires, sig] = raw.split('.');
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  return safeEqual(sig, sign(expires));
}

function loginPage(error) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entrar - ${APP_NAME}</title><link rel="icon" type="image/png" href="/marca/icone.png"><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
form{background:#1e293b;padding:32px;border-radius:12px;width:100%;max-width:380px;margin:16px;box-shadow:0 10px 30px #0006}
.marca{background:#fff;margin:-32px -32px 24px;padding:18px 28px;border-radius:12px 12px 0 0}.marca img{display:block;width:100%;height:auto}
h1{font-size:20px;margin:0 0 20px}label{display:block;font-size:13px;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}
.err{background:#7f1d1d;padding:8px 10px;border-radius:6px;font-size:13px}
.credito{margin-top:18px;text-align:center;font-size:12px;color:#94a3b8}.credito strong{color:#e2e8f0}</style></head><body>
<form method="post" action="/login" onsubmit="try{sessionStorage.setItem('captador_auth','1')}catch(e){}"><div class="marca"><img src="/marca/logo-completa.jpg" alt="${APP_NAME}" width="760" height="342"></div>${error ? `<div class="err">${error}</div>` : ''}
<label>Usuário</label><input name="usuario" autocomplete="username" required autofocus>
<label>Senha</label><input name="senha" type="password" autocomplete="current-password" required>
<button type="submit">Entrar</button>
<div class="credito">Desenvolvido por <strong>Guilherme Fernandes Leal De Souza</strong></div></form></body></html>`;
}

const loginAttempts = new Map();

// Logo e ícone usados na tela de login (públicos, antes da autenticação)
app.get('/marca/logo-completa.jpg', (req, res) => res.sendFile(path.join(__dirname, 'assets', 'logo-completa.jpg'), { maxAge: '7d' }));
app.get('/marca/icone.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'logo.png'), { maxAge: '7d' }));

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  res.type('html').send(loginPage());
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (attempts.length >= 10) {
    return res.status(429).type('html').send(loginPage('Muitas tentativas. Aguarde alguns minutos.'));
  }
  const ok = APP_PASSWORD && safeEqual(req.body?.usuario || '', APP_USER) && safeEqual(req.body?.senha || '', APP_PASSWORD);
  if (!ok) {
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    return res.status(401).type('html').send(loginPage('Usuário ou senha inválidos.'));
  }
  loginAttempts.delete(ip);
  const expires = String(now + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, `${expires}.${sign(expires)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure
  });
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/login');
});

app.use((req, res, next) => {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  res.redirect('/login');
});

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
