// =========================================================================
// CAMADA DE SEGURANÇA DO SERVIDOR WEB
// -------------------------------------------------------------------------
//  - Cabeçalhos HTTP de proteção (CSP, HSTS, anti-clickjacking, nosniff...)
//  - Sessões no servidor (encerráveis), com expiração absoluta e por inatividade
//  - Proteção contra força bruta no login e limite de requisições na API
//  - Verificação de origem (CSRF) e redirecionamento para HTTPS
//  - Segundo fator de autenticação (TOTP: Google Authenticator, Authy...)
//  - Restrição de caminhos de arquivo à pasta de dados do servidor
//  - Registro de auditoria de acessos
// =========================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;

const hashCsp = (conteudo) => `'sha256-${crypto.createHash('sha256').update(conteudo, 'utf8').digest('base64')}'`;

function compararSeguro(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const escaparHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function lerCookie(req, nome) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) {
      try { return decodeURIComponent(v.join('=')); } catch (_) { return null; }
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Cabeçalhos HTTP
// ------------------------------------------------------------------
function politicaCsp(hashesScripts, https) {
  return [
    "default-src 'self'",
    `script-src 'self' ${hashesScripts.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    https ? 'upgrade-insecure-requests' : ''
  ].filter(Boolean).join('; ');
}

// Relatórios HTML gerados pelo sistema abrem isolados (sem acesso à sessão nem à API)
const CSP_ARQUIVO_HTML = "sandbox allow-scripts allow-popups allow-modals; default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: blob:";

function cabecalhos(obterHashesScripts) {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', politicaCsp(obterHashesScripts(), req.secure));
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    // Dados fiscais nunca ficam em cache do navegador/proxy (exceto arquivos estáticos com hash)
    if (!/^\/(assets|marca)\//.test(req.path)) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

// Força HTTPS quando o servidor está atrás de um proxy com TLS (Railway, Render, Nginx...)
function forcarHttps(ativo) {
  return (req, res, next) => {
    if (ativo && req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  };
}

// Bloqueia requisições que alteram dados vindas de outro site (CSRF)
function verificarOrigem(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Requisição de outra origem bloqueada.' });
  const origem = req.headers.origin;
  if (origem && origem !== 'null') {
    try {
      if (new URL(origem).host !== req.headers.host) return res.status(403).json({ error: 'Requisição de outra origem bloqueada.' });
    } catch (_) {
      return res.status(403).json({ error: 'Origem inválida.' });
    }
  }
  next();
}

// ------------------------------------------------------------------
// Auditoria de acessos (logs/acessos.log, uma linha JSON por evento)
// ------------------------------------------------------------------
function criarAuditoria(userDataDir) {
  const dir = path.join(userDataDir, 'logs');
  const arquivo = path.join(dir, 'acessos.log');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  function registrar(evento, req, extra = {}) {
    const linha = {
      data: new Date().toISOString(),
      evento,
      ip: req ? req.ip : '',
      navegador: req ? String(req.headers['user-agent'] || '').slice(0, 200) : '',
      ...extra
    };
    try {
      if (fs.existsSync(arquivo) && fs.statSync(arquivo).size > 5 * 1024 * 1024) fs.renameSync(arquivo, `${arquivo}.1`);
      fs.appendFileSync(arquivo, JSON.stringify(linha) + '\n', { mode: 0o600 });
    } catch (_) {}
    if (evento !== 'login_ok') console.warn(`[Segurança] ${evento} — IP ${linha.ip}${extra.detalhe ? ` — ${extra.detalhe}` : ''}`);
  }

  function ultimos(qtd = 30) {
    try {
      const linhas = fs.readFileSync(arquivo, 'utf8').trim().split('\n').slice(-qtd).reverse();
      return linhas.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  return { registrar, ultimos };
}

// ------------------------------------------------------------------
// Sessões no servidor
// ------------------------------------------------------------------
function criarSessoes({ horasMaximas, minutosInatividade }) {
  const sessoes = new Map();
  const NOME_SEGURO = '__Host-captador_sessao';
  const NOME_LOCAL = 'captador_sessao';
  const digitalNavegador = (req) => crypto.createHash('sha256').update(String(req.headers['user-agent'] || '')).digest('hex');

  setInterval(() => {
    const agora = Date.now();
    for (const [id, s] of sessoes) {
      if (agora - s.criada > horasMaximas * HORA || (minutosInatividade > 0 && agora - s.ultimoAcesso > minutosInatividade * MINUTO)) sessoes.delete(id);
    }
  }, 5 * MINUTO).unref();

  function criar(req, res) {
    const id = crypto.randomBytes(32).toString('hex');
    sessoes.set(id, { criada: Date.now(), ultimoAcesso: Date.now(), ip: req.ip, navegador: digitalNavegador(req), descricao: String(req.headers['user-agent'] || '').slice(0, 120) });
    res.cookie(req.secure ? NOME_SEGURO : NOME_LOCAL, id, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
    return id;
  }

  function idDaRequisicao(req) {
    return lerCookie(req, NOME_SEGURO) || lerCookie(req, NOME_LOCAL);
  }

  function validar(req) {
    const id = idDaRequisicao(req);
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
    const s = sessoes.get(id);
    if (!s) return null;
    const agora = Date.now();
    const expirada = agora - s.criada > horasMaximas * HORA || (minutosInatividade > 0 && agora - s.ultimoAcesso > minutosInatividade * MINUTO);
    // Cookie copiado para outro navegador não é aceito
    if (expirada || s.navegador !== digitalNavegador(req)) {
      sessoes.delete(id);
      return null;
    }
    s.ultimoAcesso = agora;
    return { id, ...s };
  }

  function encerrar(req, res) {
    const id = idDaRequisicao(req);
    if (id) sessoes.delete(id);
    res.clearCookie(NOME_SEGURO, { path: '/', secure: true, sameSite: 'strict' });
    res.clearCookie(NOME_LOCAL, { path: '/' });
  }

  function encerrarOutras(idAtual) {
    let total = 0;
    for (const id of sessoes.keys()) if (id !== idAtual) { sessoes.delete(id); total++; }
    return total;
  }

  const listar = () => [...sessoes.entries()].map(([id, s]) => ({ id, ...s }));

  return { criar, validar, encerrar, encerrarOutras, listar };
}

// ------------------------------------------------------------------
// Limites de tentativas (login) e de requisições (API)
// ------------------------------------------------------------------
function criarLimitadorLogin({ maxPorIp = 5, janelaMin = 15 } = {}) {
  const porIp = new Map();
  let falhasGlobais = [];

  const recentes = (lista) => lista.filter((t) => Date.now() - t < janelaMin * MINUTO);

  return {
    bloqueado(ip) {
      const lista = recentes(porIp.get(ip) || []);
      porIp.set(ip, lista);
      return lista.length >= maxPorIp;
    },
    falha(ip) {
      porIp.set(ip, [...recentes(porIp.get(ip) || []), Date.now()]);
      falhasGlobais = [...recentes(falhasGlobais), Date.now()];
    },
    sucesso(ip) {
      porIp.delete(ip);
    },
    // Atraso crescente em ataques distribuídos (muitos IPs), sem bloquear o dono da conta
    atrasoMs() {
      return Math.min(recentes(falhasGlobais).length * 250, 5000);
    }
  };
}

function limitarRequisicoes({ maximo = 600, janelaMs = MINUTO } = {}) {
  const contagem = new Map();
  setInterval(() => contagem.clear(), janelaMs).unref();
  return (chave) => {
    const n = (contagem.get(chave) || 0) + 1;
    contagem.set(chave, n);
    return n <= maximo;
  };
}

// ------------------------------------------------------------------
// Segundo fator (TOTP - RFC 6238)
// ------------------------------------------------------------------
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decodificar(txt) {
  const limpo = String(txt || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of limpo) bits += BASE32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function base32Codificar(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function codigoTotp(segredo, contador) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(contador));
  const hmac = crypto.createHmac('sha1', base32Decodificar(segredo)).update(msg).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

function criarTotp(segredo) {
  let ultimoContadorUsado = -1;
  return {
    ativo: !!segredo && base32Decodificar(segredo).length >= 10,
    // Aceita o código atual e os vizinhos (±30s); o mesmo código não pode ser reutilizado
    verificar(codigo) {
      const c = String(codigo || '').replace(/\D/g, '');
      if (c.length !== 6) return false;
      const atual = Math.floor(Date.now() / 30000);
      for (const d of [0, -1, 1]) {
        const contador = atual + d;
        if (contador > ultimoContadorUsado && compararSeguro(codigoTotp(segredo, contador), c)) {
          ultimoContadorUsado = contador;
          return true;
        }
      }
      return false;
    }
  };
}

const gerarSegredoTotp = () => base32Codificar(crypto.randomBytes(20));
const verificarTotpAvulso = (segredo, codigo) => {
  const atual = Math.floor(Date.now() / 30000);
  return [0, -1, 1].some((d) => codigoTotp(segredo, atual + d) === String(codigo || '').replace(/\D/g, ''));
};

// ------------------------------------------------------------------
// Caminhos de arquivo vindos do navegador: só dentro da pasta de dados
// ------------------------------------------------------------------
function criarGuardaCaminhos(raizes) {
  const bases = raizes.filter(Boolean).map((r) => path.resolve(r));
  const pareceCaminho = (s) => s.length < 1024 && !/[\r\n]/.test(s) &&
    (/^(\/|\\\\|[A-Za-z]:[\\/])/.test(s) || /(^|[\\/])\.\.([\\/]|$)/.test(s));
  const permitido = (s) => {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return false;
    const r = path.resolve(s);
    return bases.some((b) => r === b || r.startsWith(b + path.sep));
  };

  // Percorre os argumentos; rejeita caminhos fora da pasta de dados e chaves de prototype pollution
  function verificar(valor, profundidade = 0) {
    if (profundidade > 12 || valor == null) return;
    if (typeof valor === 'string') {
      if (pareceCaminho(valor) && !permitido(valor)) {
        const err = new Error('Caminho de arquivo não permitido.');
        err.status = 400;
        throw err;
      }
      return;
    }
    if (Array.isArray(valor)) { valor.forEach((v) => verificar(v, profundidade + 1)); return; }
    if (typeof valor === 'object') {
      for (const k of Object.keys(valor)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          const err = new Error('Parâmetro inválido.');
          err.status = 400;
          throw err;
        }
        verificar(valor[k], profundidade + 1);
      }
    }
  }

  return { verificar, permitido };
}

function avaliarSenha(senha) {
  const s = String(senha || '');
  const tipos = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  if (s.length >= 14 && tipos >= 3) return { forte: true, motivo: 'Senha forte' };
  if (s.length < 12) return { forte: false, motivo: `Senha curta (${s.length} caracteres). Use 14 ou mais.` };
  return { forte: false, motivo: 'Misture letras maiúsculas, minúsculas, números e símbolos.' };
}

module.exports = {
  hashCsp, compararSeguro, escaparHtml, cabecalhos, forcarHttps, verificarOrigem, CSP_ARQUIVO_HTML,
  criarAuditoria, criarSessoes, criarLimitadorLogin, limitarRequisicoes,
  criarTotp, gerarSegredoTotp, verificarTotpAvulso, criarGuardaCaminhos, avaliarSenha
};
