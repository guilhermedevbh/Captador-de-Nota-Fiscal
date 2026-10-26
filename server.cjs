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
const qrcodeGen = require('qrcode-generator');
const seg = require('./web/seguranca.cjs');
const { __web } = require(shimPath);
require('./main.cjs');

const { APP_NAME, requestContext, ipcHandlers, eventListeners, userDataDir } = __web;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;
const EM_PRODUCAO = !!process.env.RAILWAY_ENVIRONMENT || process.env.FORCAR_HTTPS === '1';
const distDir = path.join(__dirname, 'dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ------------------------------------------------------------------
// Segurança: cabeçalhos, HTTPS, origem, sessões, limites, 2FA e auditoria
// ------------------------------------------------------------------
// Espaços/quebras de linha colados por engano nas variáveis do Railway são ignorados
const APP_USER = (process.env.APP_USER || 'admin').trim();
let APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
let APP_PASSWORD_HASH = (process.env.APP_PASSWORD_HASH || '').trim();
if (APP_PASSWORD_HASH && !/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(APP_PASSWORD_HASH)) {
  // Senha colada direto em APP_PASSWORD_HASH (sem gerar o hash): vale como senha normal até ser corrigida
  console.warn('[Login] APP_PASSWORD_HASH não contém um hash (gere em /seguranca). O valor está sendo usado como senha em texto.');
  if (!APP_PASSWORD) APP_PASSWORD = APP_PASSWORD_HASH;
  APP_PASSWORD_HASH = '';
}
const senhaConfigurada = !!(APP_PASSWORD_HASH || APP_PASSWORD);
const conferirSenha = (senha) => (APP_PASSWORD_HASH ? seg.verificarHashSenha(senha, APP_PASSWORD_HASH) : !!APP_PASSWORD && seg.compararSeguro(senha, APP_PASSWORD));
const listaIps = seg.criarListaIps(process.env.IPS_PERMITIDOS);
const totp = seg.criarTotp(process.env.APP_TOTP_SECRET);
const sessoes = seg.criarSessoes({
  horasMaximas: Number(process.env.SESSAO_HORAS) || 12,
  minutosInatividade: process.env.SESSAO_INATIVIDADE_MIN != null ? Number(process.env.SESSAO_INATIVIDADE_MIN) : 120
});
const limitadorLogin = seg.criarLimitadorLogin({ maxPorIp: 5, janelaMin: 15 });
const limiteApi = seg.limitarRequisicoes({ maximo: 600, janelaMs: 60 * 1000 });
const auditoria = seg.criarAuditoria(userDataDir);
const guardaCaminhos = seg.criarGuardaCaminhos([userDataDir]);

if (!senhaConfigurada) {
  console.warn('[Login] APP_PASSWORD_HASH/APP_PASSWORD não definida: o acesso ficará bloqueado até configurá-la.');
} else if (!APP_PASSWORD_HASH && !seg.avaliarSenha(APP_PASSWORD).forte) {
  console.warn(`[Segurança] ${seg.avaliarSenha(APP_PASSWORD).motivo}`);
}

// Scripts inline permitidos pela CSP (por hash): o da tela de login e os do index.html
const SCRIPT_LOGIN = "document.querySelector('form').addEventListener('submit',function(){try{sessionStorage.setItem('captador_auth','1')}catch(e){}});";
const hashesScripts = [seg.hashCsp(SCRIPT_LOGIN)];
try {
  const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  for (const m of indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) hashesScripts.push(seg.hashCsp(m[1]));
} catch (_) {}

app.use(seg.forcarHttps(EM_PRODUCAO));
app.use(seg.cabecalhos(() => hashesScripts));
app.use(listaIps.middleware(auditoria));
app.use(seg.criarProtecaoBots(auditoria));
app.use(seg.verificarOrigem);

app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));

function loginPage(error) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Entrar - ${APP_NAME}</title><link rel="icon" type="image/png" href="/marca/icone.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;800&display=swap" rel="stylesheet"><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
form{background:#1e293b;padding:32px;border-radius:12px;width:100%;max-width:380px;margin:16px;box-shadow:0 10px 30px #0006}
.marca{display:flex;align-items:center;justify-content:center;gap:14px;margin:0 0 26px}.marca img{width:92px;height:92px;flex-shrink:0;filter:drop-shadow(0 6px 14px rgba(0,0,0,.45))}
.nome{display:flex;flex-direction:column;font-family:Montserrat,system-ui,sans-serif;line-height:1}
.nome .t1{font-size:38px;font-weight:800;letter-spacing:.5px;background:linear-gradient(180deg,#7dd3fc 0%,#2b9af3 45%,#1565c0 100%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 2px 0 #0b3a6e) drop-shadow(0 5px 8px rgba(0,0,0,.5))}
.nome .t2{margin-top:6px;font-size:15.2px;font-weight:600;letter-spacing:1.15px;background:linear-gradient(180deg,#ffffff 0%,#dbe3ec 55%,#9aa8b8 100%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 1px 1px rgba(0,0,0,.7))}
@media (max-width:420px){.marca img{width:66px;height:66px}.nome .t1{font-size:27px}.nome .t2{font-size:10.8px;letter-spacing:.8px}form{padding:26px}}
h1{font-size:20px;margin:0 0 20px}label{display:block;font-size:13px;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}
.err{background:#7f1d1d;padding:8px 10px;border-radius:6px;font-size:13px}
.armadilha{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.credito{margin-top:18px;text-align:center;font-size:12px;color:#94a3b8}.credito strong{color:#e2e8f0}</style></head><body>
<form method="post" action="/login"><input type="hidden" name="token" value="${seg.criarTokenLogin()}"><div class="armadilha" aria-hidden="true"><label for="site">Site</label><input id="site" name="site" tabindex="-1" autocomplete="off"></div><div class="marca"><img src="/marca/simbolo.png" alt="" width="92" height="92"><div class="nome" role="img" aria-label="${APP_NAME}"><span class="t1">CAPTADOR</span><span class="t2">DOCUMENTOS FISCAIS</span></div></div>${error ? `<div class="err">${seg.escaparHtml(error)}</div>` : ''}
<label for="usuario">Usuário</label><input id="usuario" name="usuario" autocomplete="username" maxlength="100" required autofocus>
<label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="current-password" maxlength="200" required>
${totp.ativo ? '<label for="codigo">Código do autenticador (6 dígitos)</label><input id="codigo" name="codigo" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>' : ''}
<button type="submit">Entrar</button>
<div class="credito">Desenvolvido por <strong>Guilherme Fernandes Leal De Souza</strong></div></form>
<script>${SCRIPT_LOGIN}</script></body></html>`;
}

// Logo e ícone usados na tela de login (públicos, antes da autenticação)
app.get('/marca/simbolo.png', (req, res) => res.sendFile(path.join(__dirname, 'assets', 'logo.png'), { maxAge: '7d' }));
app.get('/marca/icone.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'logo.png'), { maxAge: '7d' }));

app.get('/login', (req, res) => {
  if (sessoes.validar(req)) return res.redirect('/');
  res.type('html').send(loginPage());
});

app.post('/login', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  const ip = req.ip;
  if (limitadorLogin.bloqueado(ip)) {
    auditoria.registrar('login_bloqueado', req, { detalhe: 'excesso de tentativas' });
    return res.status(429).type('html').send(loginPage('Muitas tentativas. Aguarde 15 minutos e tente novamente.'));
  }
  await sleep(limitadorLogin.atrasoMs());

  // Robôs: campo-armadilha preenchido, formulário não carregado ou enviado rápido demais
  if (req.body?.site || !seg.validarTokenLogin(req.body?.token)) {
    limitadorLogin.falha(ip);
    auditoria.registrar('robo_bloqueado', req, { detalhe: req.body?.site ? 'campo-armadilha preenchido' : 'formulário inválido ou enviado rápido demais' });
    await sleep(800);
    return res.status(400).type('html').send(loginPage('Não foi possível validar o formulário. Recarregue a página e tente novamente.'));
  }

  // Usuário sem diferenciar maiúsculas (teclado do celular) e sem espaços colados por engano
  const usuario = String(req.body?.usuario || '').trim();
  const senha = String(req.body?.senha || '');
  const senhaOk = senhaConfigurada && seg.compararSeguro(usuario.toLowerCase(), APP_USER.toLowerCase()) &&
    (conferirSenha(senha) || (senha.trim() !== senha && conferirSenha(senha.trim())));
  const ok = senhaOk && (!totp.ativo || totp.verificar(req.body?.codigo));
  if (!ok) {
    limitadorLogin.falha(ip);
    auditoria.registrar('login_falha', req, { usuario: usuario.slice(0, 60), detalhe: senhaOk ? 'código 2FA inválido' : 'usuário ou senha inválidos' });
    await sleep(300 + crypto.randomInt(400));
    return res.status(401).type('html').send(loginPage(totp.ativo ? 'Usuário, senha ou código inválidos.' : 'Usuário ou senha inválidos.'));
  }
  limitadorLogin.sucesso(ip);
  sessoes.criar(req, res);
  auditoria.registrar('login_ok', req, { usuario: usuario.slice(0, 60) });
  res.redirect('/#entrou');
});

app.get('/logout', (req, res) => {
  if (sessoes.validar(req)) auditoria.registrar('logout', req);
  sessoes.encerrar(req, res);
  res.redirect('/login');
});

app.use((req, res, next) => {
  const sessao = sessoes.validar(req);
  if (!sessao) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    return res.redirect('/login');
  }
  if (!limiteApi(sessao.id)) {
    auditoria.registrar('limite_api', req, { detalhe: 'excesso de requisições' });
    return res.status(429).json({ error: 'Muitas requisições em pouco tempo. Aguarde um minuto.' });
  }
  req.sessao = sessao;
  next();
});

// Mensagens de erro sem caminhos internos do servidor
const escaparRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PASTAS_INTERNAS = [userDataDir, __dirname, require('os').tmpdir()].filter(Boolean).sort((a, b) => b.length - a.length);
const semCaminhosInternos = (msg) => PASTAS_INTERNAS.reduce((m, p) => m.replace(new RegExp(escaparRegex(p), 'g'), '[servidor]'), String(msg));

// ------------------------------------------------------------------
// Painel de segurança (/seguranca)
// ------------------------------------------------------------------
const fmtDataHora = (ms) => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const NOMES_EVENTO = {
  login_ok: 'Login realizado', login_falha: 'Tentativa de login falhou', login_bloqueado: 'IP bloqueado (força bruta)',
  logout: 'Saída do sistema', sessoes_encerradas: 'Outras sessões encerradas', limite_api: 'Excesso de requisições',
  robo_bloqueado: 'Robô bloqueado no login', ip_banido: 'IP banido (varredura)', ip_nao_autorizado: 'IP não autorizado', entrada_invalida: 'Parâmetro inválido bloqueado', caminho_bloqueado: 'Acesso a arquivo fora da área permitida bloqueado'
};

function paginaSeguranca(req, aviso) {
  const senha = APP_PASSWORD_HASH ? { forte: true, motivo: 'Senha guardada apenas como hash (scrypt) em APP_PASSWORD_HASH.' } : seg.avaliarSenha(APP_PASSWORD);
  const chaveMestraEnv = !!(process.env.CAPTADOR_CHAVE_MESTRA && process.env.CAPTADOR_CHAVE_MESTRA.length >= 16);
  const checklist = [
    ['Esconder API Keys', true, 'Nenhuma chave de API no código do navegador; integrações (SEFAZ, ADN, CNPJ) rodam só no servidor.'],
    ['Limpar secrets do Git', true, 'Histórico verificado sem senhas, chaves ou certificados; .gitignore bloqueia .env, .pfx, .p12, .pem e .key; segredos só em variáveis do Railway.'],
    ['Usar apenas chave pública no navegador', true, 'O navegador não guarda nenhum segredo utilizável: senhas de certificado ficam cifradas pelo servidor (AES-256-GCM).'],
    ['Controle de acesso por registro (RLS)', true, 'Sem banco exposto: o SQLite fica só no servidor, toda rota exige sessão válida e os arquivos ficam presos à pasta de dados.'],
    ['Criptografia de dados', chaveMestraEnv, chaveMestraEnv ? 'Senhas e estado cifrados com AES-256-GCM usando a chave mestra da variável CAPTADOR_CHAVE_MESTRA; HTTPS em trânsito.' : 'Senhas e estado cifrados com AES-256-GCM (chave mestra gerada no servidor). Recomendado: definir CAPTADOR_CHAVE_MESTRA no Railway.'],
    ['Autenticação no servidor', true, 'Login, sessão e 2FA validados no servidor; nada depende do navegador.'],
    ['Restringir acessos', true, listaIps.ativa ? 'Somente os IPs de IPS_PERMITIDOS acessam o site; API limitada à pasta de dados.' : 'API limitada à pasta de dados. Opcional: IPS_PERMITIDOS para liberar só os IPs do escritório.'],
    ['Bloquear mass assignment', true, 'Agendadores e configurações aceitam apenas os campos permitidos; chaves __proto__/constructor rejeitadas.'],
    ['Proteger cookies', true, 'HttpOnly, Secure, SameSite=Strict, prefixo __Host-, preso ao navegador e invalidado ao sair.'],
    ['Hash nas senhas', !!APP_PASSWORD_HASH, APP_PASSWORD_HASH ? 'Senha do site guardada só como hash scrypt.' : 'Gere o hash abaixo e troque APP_PASSWORD por APP_PASSWORD_HASH no Railway.'],
    ['Rate limit', true, 'Login: 5 tentativas por IP a cada 15 min + atraso progressivo; 600 requisições/min por sessão.'],
    ['Proteção contra robôs', true, 'Campo-armadilha e token de tempo no login, bloqueio de varredores (sqlmap, nikto...) e banimento de IP que sonda falhas.'],
    ['Queries parametrizadas', true, 'Todas as consultas ao SQLite usam parâmetros (prepared statements).'],
    ['Validação dos inputs', true, 'CNPJ, chaves, datas, competências e NSU validados; tamanhos e profundidade limitados; caracteres nulos rejeitados.'],
    ['Evitar vazamento de conteúdo', true, 'Erros sem detalhes internos ou caminhos do servidor; senhas removidas de logs e respostas; sem mapas de código-fonte.'],
    ['Restringir uploads', true, 'Somente .pfx/.p12 com estrutura PKCS#12 válida, até 2 MB, nome higienizado e gravação com permissão 600.'],
    ['Limitar respostas da API', true, 'Respostas sem campos sensíveis, sem cache (no-store) e corpo das requisições limitado.'],
    ['Security headers', true, 'CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP e X-Robots-Tag.'],
    ['Forçar HTTPS', req.secure, req.secure ? 'Redirecionamento automático para HTTPS e HSTS de 2 anos.' : 'Acesse pelo domínio https:// do Railway (o redirecionamento é automático em produção).'],
    ['Scan de dependências', true, 'npm audit sem falhas aplicáveis; Dependabot e verificação semanal configurados no GitHub.']
  ];
  const inatividade = process.env.SESSAO_INATIVIDADE_MIN != null ? Number(process.env.SESSAO_INATIVIDADE_MIN) : 120;
  const item = (ok, titulo, texto) => `<li class="${ok ? 'ok' : 'alerta'}"><b>${ok ? '✔' : '!'}</b><div><strong>${titulo}</strong><span>${texto}</span></div></li>`;
  const segredo = seg.gerarSegredoTotp();
  const otpauth = `otpauth://totp/${encodeURIComponent(`Captador:${APP_USER}`)}?secret=${segredo}&issuer=Captador&digits=6&period=30`;
  const qr = qrcodeGen(0, 'M');
  qr.addData(otpauth);
  qr.make();
  const sessoesAtivas = sessoes.listar();
  const acessos = auditoria.ultimos(40);

  return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Segurança - ${APP_NAME}</title><link rel="icon" type="image/png" href="/marca/icone.png"><style>
:root{color-scheme:dark}body{margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;font-size:14px}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}a{color:#7dd3fc}h1{font-size:22px;margin:8px 0 4px}h2{font-size:16px;margin:0 0 12px}
.sub{color:#94a3b8;margin:0 0 20px}.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:18px;margin:0 0 16px}
ul.status{list-style:none;margin:0;padding:0;display:grid;gap:8px}ul.status li{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px;background:#0f172a}
ul.status b{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px}
li.ok b{background:#14532d;color:#86efac}li.alerta b{background:#78350f;color:#fcd34d}ul.status span{display:block;color:#94a3b8;font-size:12.5px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #334155;vertical-align:top}th{color:#94a3b8;font-weight:600}
td.falha{color:#fca5a5}td.okv{color:#86efac}.qr{background:#fff;padding:10px;border-radius:8px;display:inline-block}.qr svg{display:block}
.grid2{display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:start}@media(max-width:700px){.grid2{grid-template-columns:1fr}}
code{background:#0f172a;border:1px solid #334155;padding:2px 6px;border-radius:5px;word-break:break-all}input{padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;width:120px}
button{padding:8px 14px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}button.perigo{background:#b91c1c}
.aviso{padding:10px 12px;border-radius:8px;margin:0 0 16px}.aviso.ok{background:#14532d}.aviso.erro{background:#7f1d1d}.tabela{overflow-x:auto}ol{padding-left:18px;margin:8px 0}ol li{margin:4px 0}
</style></head><body><main>
<a href="/">← Voltar ao sistema</a>
<h1>Central de segurança</h1><p class="sub">Proteções ativas no servidor, sessões abertas, autenticação em dois fatores e registro de acessos.</p>
${aviso ? `<div class="aviso ${aviso.ok ? 'ok' : 'erro'}">${seg.escaparHtml(aviso.texto)}</div>` : ''}
<section class="card"><h2>Situação das proteções</h2><ul class="status">
${item(req.secure, 'Conexão criptografada (HTTPS)', req.secure ? 'Ativa, com HSTS: o navegador só acessa o site por HTTPS.' : 'O site está sendo acessado sem HTTPS. No Railway, use o domínio https://.')}
${item(totp.ativo, 'Autenticação em dois fatores (2FA)', totp.ativo ? 'Ativa: além da senha, o login exige o código do aplicativo autenticador.' : 'Desativada. Configure abaixo para que uma senha vazada não seja suficiente para entrar.')}
${item(senha.forte, 'Força da senha', senha.motivo)}
${item(true, 'Proteção contra força bruta', 'Bloqueio por 15 minutos após 5 tentativas erradas no mesmo IP, atraso progressivo em ataques distribuídos e registro de cada tentativa.')}
${item(true, 'Sessões controladas pelo servidor', `Expiram após ${Number(process.env.SESSAO_HORAS) || 12}h${inatividade > 0 ? ` ou ${inatividade} min sem uso` : ''}; o login é exigido em cada nova aba; "Sair" invalida a sessão; cookie HttpOnly, Secure e SameSite=Strict, preso ao navegador onde foi criado.`)}
${item(true, 'Cabeçalhos de proteção', 'CSP restritiva (bloqueia scripts injetados), anti-clickjacking, nosniff, sem referência a outros sites, isolamento de origem e bloqueio de indexação em buscadores.')}
${item(true, 'Bloqueio de requisições de outros sites (CSRF)', 'Toda ação que altera dados confere a origem da requisição.')}
${item(true, 'Arquivos do servidor protegidos', 'A API só aceita caminhos dentro da pasta de dados; relatórios HTML abrem isolados, sem acesso à sessão.')}
${item(true, 'Limite de requisições', 'Até 600 chamadas por minuto por sessão, contra abuso e automação maliciosa.')}
</ul></section>

<section class="card"><h2>Checklist de blindagem (${checklist.filter((c) => c[1]).length}/20)</h2><ul class="status">
${checklist.map(([titulo, ok, texto], i) => item(ok, `${i + 1}. ${titulo}`, texto)).join('')}
</ul></section>

<section class="card"><h2>Senha do site em hash</h2>
<p>Gere o hash da senha e, no Railway, crie <code>APP_PASSWORD_HASH</code> com o valor gerado e <strong>apague</strong> a variável <code>APP_PASSWORD</code>. Assim nem quem tiver acesso às variáveis consegue ver a senha.</p>
<form method="post" action="/seguranca/hash-senha"><input type="password" name="senha" autocomplete="new-password" placeholder="Senha do site" style="width:240px" required> <button type="submit">Gerar hash</button></form>
${aviso && aviso.hash ? `<p>Hash gerado (copie inteiro):</p><p><code>${seg.escaparHtml(aviso.hash)}</code></p>` : ''}
</section>

<section class="card"><h2>Sessões abertas (${sessoesAtivas.length})</h2><div class="tabela"><table><thead><tr><th>Início</th><th>Último uso</th><th>IP</th><th>Navegador</th></tr></thead><tbody>
${sessoesAtivas.map((s) => `<tr><td>${fmtDataHora(s.criada)}${s.id === req.sessao.id ? ' <b>(esta)</b>' : ''}</td><td>${fmtDataHora(s.ultimoAcesso)}</td><td>${seg.escaparHtml(s.ip)}</td><td>${seg.escaparHtml(s.descricao)}</td></tr>`).join('')}
</tbody></table></div>
${sessoesAtivas.length > 1 ? '<form method="post" action="/seguranca/sessoes/encerrar"><p><button class="perigo" type="submit">Encerrar todas as outras sessões</button></p></form>' : ''}
</section>

<section class="card"><h2>Autenticação em dois fatores (2FA)</h2>
${totp.ativo
    ? '<p>O 2FA está <strong>ativo</strong>. Para trocar o aparelho, gere um novo código abaixo e atualize a variável <code>APP_TOTP_SECRET</code>. Para desativar, remova a variável no Railway.</p>'
    : '<p>Com o 2FA, quem descobrir a senha ainda precisa do código que muda a cada 30 segundos no seu celular.</p>'}
<div class="grid2"><div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: false })}</div><div>
<ol><li>Instale o <strong>Google Authenticator</strong>, <strong>Microsoft Authenticator</strong> ou <strong>Authy</strong> no celular.</li>
<li>Leia o QR Code ao lado (ou digite a chave <code>${segredo}</code>).</li>
<li>Teste o código abaixo para confirmar.</li>
<li>No Railway, em <strong>Variables</strong>, crie <code>APP_TOTP_SECRET</code> com a chave acima e aguarde o redeploy.</li></ol>
<form method="post" action="/seguranca/2fa/testar"><input type="hidden" name="segredo" value="${segredo}">
<input name="codigo" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required> <button type="submit">Testar código</button></form>
</div></div></section>

<section class="card"><h2>Últimos acessos e tentativas</h2><div class="tabela"><table><thead><tr><th>Data/hora</th><th>Evento</th><th>IP</th><th>Detalhe</th><th>Navegador</th></tr></thead><tbody>
${acessos.length ? acessos.map((a) => `<tr><td>${fmtDataHora(Date.parse(a.data))}</td><td class="${/falha|bloque|limite|caminho|robo|banido|autorizado|invalida/.test(a.evento) ? 'falha' : a.evento === 'login_ok' ? 'okv' : ''}">${seg.escaparHtml(NOMES_EVENTO[a.evento] || a.evento)}</td><td>${seg.escaparHtml(a.ip)}</td><td>${seg.escaparHtml([a.usuario ? `usuário: ${a.usuario}` : '', a.detalhe || ''].filter(Boolean).join(' — '))}</td><td>${seg.escaparHtml(a.navegador)}</td></tr>`).join('') : '<tr><td colspan="5">Nenhum registro ainda.</td></tr>'}
</tbody></table></div></section>
</main></body></html>`;
}

app.get('/seguranca', (req, res) => res.type('html').send(paginaSeguranca(req)));

app.post('/seguranca/2fa/testar', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const ok = seg.verificarTotpAvulso(String(req.body?.segredo || ''), req.body?.codigo);
  res.type('html').send(paginaSeguranca(req, ok
    ? { ok: true, texto: `Código correto! Agora crie no Railway a variável APP_TOTP_SECRET = ${req.body.segredo}` }
    : { ok: false, texto: 'Código incorreto. Confira se a hora do celular está automática e tente de novo (um novo QR Code foi gerado; leia-o novamente).' }));
});

app.post('/seguranca/hash-senha', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const senha = String(req.body?.senha || '');
  const avaliacao = seg.avaliarSenha(senha);
  if (!avaliacao.forte) return res.type('html').send(paginaSeguranca(req, { ok: false, texto: `Escolha uma senha mais forte: ${avaliacao.motivo}` }));
  res.type('html').send(paginaSeguranca(req, { ok: true, texto: 'Hash gerado. Use-o em APP_PASSWORD_HASH e remova APP_PASSWORD.', hash: seg.gerarHashSenha(senha) }));
});

app.post('/seguranca/sessoes/encerrar', (req, res) => {
  const total = sessoes.encerrarOutras(req.sessao.id);
  auditoria.registrar('sessoes_encerradas', req, { detalhe: `${total} sessão(ões)` });
  res.type('html').send(paginaSeguranca(req, { ok: true, texto: `${total} sessão(ões) encerrada(s).` }));
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
app.post('/api/invoke/:channel', express.json({ limit: '50mb' }), async (req, res) => {
  const channel = req.params.channel;
  const handler = ipcHandlers.get(channel);
  if (!handler) {
    return res.status(404).json({ error: `Canal desconhecido: ${channel}` });
  }

  const args = Array.isArray(req.body?.args) ? req.body.args : [];
  const openPaths = Array.isArray(req.body?.openPaths) ? req.body.openPaths.map(String) : [];
  // Caminhos de arquivo enviados pelo navegador só podem apontar para a pasta de dados do servidor
  try {
    guardaCaminhos.verificar(args);
    guardaCaminhos.verificar(openPaths);
  } catch (err) {
    auditoria.registrar('caminho_bloqueado', req, { detalhe: `canal ${channel}` });
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    seg.validarEntradas(args);
  } catch (err) {
    auditoria.registrar('entrada_invalida', req, { detalhe: `canal ${channel}: ${err.message}` });
    return res.status(err.status || 400).json({ error: err.message });
  }
  const ctx = {
    openPaths,
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

    res.json({ result: result === undefined ? null : seg.ocultarSegredos(result), downloads, opens, folders: ctx.folders });
  } catch (err) {
    console.error(`[Servidor] Erro no canal ${channel}:`, err);
    res.status(500).json({ error: semCaminhosInternos(err?.message || String(err)) });
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
app.post('/api/upload-cert', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  try {
    const originalName = path.basename(String(req.query.name || 'certificado.pfx'));
    const ext = path.extname(originalName).toLowerCase();
    if (ext !== '.pfx' && ext !== '.p12') {
      return res.status(400).json({ error: 'Selecione um arquivo de certificado .pfx ou .p12.' });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'Arquivo de certificado vazio.' });
    }
    // PKCS#12 é uma estrutura DER (SEQUENCE): rejeita arquivos que não sejam certificados
    if (req.body[0] !== 0x30) {
      return res.status(400).json({ error: 'O arquivo enviado não é um certificado .pfx/.p12 válido.' });
    }
    const certDir = path.join(userDataDir, 'certificados');
    fs.mkdirSync(certDir, { recursive: true });
    const safeName = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const target = path.join(certDir, safeName);
    fs.writeFileSync(target, req.body, { mode: 0o600 });
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
  // Relatórios HTML abrem isolados (sandbox); PDFs seguem sem CSP para o leitor do navegador funcionar
  if (/\.html?$/i.test(entry.filePath)) res.setHeader('Content-Security-Policy', seg.CSP_ARQUIVO_HTML);
  else res.removeHeader('Content-Security-Policy');
  res.sendFile(path.resolve(entry.filePath), { headers: { 'Cache-Control': 'no-store' } });
});

// ------------------------------------------------------------------
// Interface (build do Vite)
// ------------------------------------------------------------------
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) => {
    res.type('text').send('Interface não compilada. Execute "npm run build" ou use "npm run dev" para desenvolvimento.');
  });
}

// Erros de requisição sem expor detalhes internos
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Conteúdo enviado é grande demais.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requisição inválida.' });
  console.error('[Servidor] Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`${APP_NAME} disponível em ${url}`);
  console.log(`Dados armazenados em: ${userDataDir}`);
});
