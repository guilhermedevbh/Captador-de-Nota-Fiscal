<div align="center">
  <img src="assets/logo.png" alt="Captador de Notas Fiscais" width="90" />
  <h1>Captador de Notas Fiscais — Versão Web</h1>
  <p>
    <strong>Captação automatizada de documentos fiscais eletrônicos (NF-e, NFC-e, CT-e e NFS-e) via Certificado Digital A1 (mTLS) e auditoria/apuração de DIFAL, agora acessível pelo navegador.</strong>
  </p>
</div>

---

## Sobre

O **Captador de Notas Fiscais** é a versão web do aplicativo desktop (Electron). Todas as funcionalidades foram mantidas:

- Painel de empresas (multi-CNPJ) com controle de validade de certificados A1
- Guia geral de notas (NF-e, NFC-e, CT-e e NFS-e)
- NF-e Entradas (modelo 55) via `NFeDistribuicaoDFe`, com manifestação automática
- NFC-e (modelo 65), CT-e (modelo 57) e NFS-e (Portal Nacional ADN e Prefeitura de São Paulo)
- Geração de DANFE / DACTE / DANFSE em PDF e exportação em ZIP / CSV
- Cálculo e auditoria de DIFAL / antecipação tributária
- Agendadores diários por modelo

## Como funciona a versão web

| Antes (desktop) | Agora (web) |
| --- | --- |
| Janela Electron | Interface React aberta no navegador |
| `ipcMain` / `ipcRenderer` | Servidor Express (`server.cjs`) com `POST /api/invoke/:canal` |
| Eventos de progresso (`webContents.send`) | Server-Sent Events em `GET /api/events` |
| Diálogo para escolher o `.pfx` | Upload do certificado pelo navegador (salvo na pasta de dados do servidor) |
| Diálogo "Salvar como" (ZIP, CSV, XML, TXT) | Download direto no navegador |
| Abrir PDF no leitor do Windows | PDF aberto em nova aba do navegador |
| Abrir pasta no Windows Explorer | Abre a pasta no computador onde o servidor está rodando |
| Bandeja do sistema / iniciar com o Windows | Removidos — os agendamentos rodam enquanto o servidor estiver ativo e a página aberta |

O backend (`main.cjs`, `sefaz/`, `nfse/`) é o mesmo do aplicativo desktop. O arquivo `web/electronShim.cjs` substitui o módulo `electron` e traduz os recursos nativos para o fluxo web.

## Requisitos

- [Node.js](https://nodejs.org/) 22.5 ou superior

## Instalação e uso

```bash
npm install
npm run web
```

Depois acesse **http://127.0.0.1:3000** no navegador.

O comando `npm run web` compila a interface (`vite build`) e inicia o servidor. Nas próximas vezes, se a interface não mudou, basta `npm start`.

### Desenvolvimento

Em dois terminais:

```bash
npm run dev:server
```

```bash
npm run dev
```

O Vite (porta 5173) encaminha as chamadas `/api` para o servidor (porta 3000).

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta do servidor |
| `HOST` | `127.0.0.1` | Endereço de escuta. Use `0.0.0.0` para liberar acesso pela rede |
| `DATA_DIR` | `%APPDATA%/Captador de Notas Fiscais` | Pasta de dados (configurações, certificados enviados, banco de estado) |
| `OPEN_FOLDERS` | `1` | Use `0` para não abrir pastas no explorador do servidor |
| `APP_USER` | `admin` | Usuário do login |
| `APP_PASSWORD` | — | Senha do login (obrigatória; sem ela ninguém entra) |
| `APP_PASSWORD_HASH` | — | Senha do site como hash scrypt (gere em `/seguranca`); substitui `APP_PASSWORD` |
| `CAPTADOR_CHAVE_MESTRA` | gerada em `DATA_DIR/.chave-mestra` | Chave que cifra senhas de certificado e o estado (16+ caracteres aleatórios) |
| `IPS_PERMITIDOS` | — | Lista de IPs/faixas liberados, ex.: `200.1.2.3, 177.10.0.0/16` |
| `APP_TOTP_SECRET` | — | Ativa o 2º fator (código do Google Authenticator/Authy). Gere em `/seguranca` |
| `SESSAO_HORAS` | `12` | Duração máxima da sessão |
| `SESSAO_INATIVIDADE_MIN` | `120` | Encerra a sessão após esse tempo sem uso (`0` desativa) |
| `FORCAR_HTTPS` | `1` no Railway | Redireciona HTTP para HTTPS quando atrás de proxy com TLS |
| `CAPTACAO_DATA_INICIAL` | `2026-01-01` | Só capta notas emitidas a partir desta data (AAAA-MM-DD) |
| `RETENCAO_HORAS` | `0` | Apaga os XMLs/PDFs captados após este número de horas (`0` = nunca apaga) |

As notas fiscais baixadas ficam em `<DATA_DIR>/sefaz_empresas` (ou na pasta escolhida em *Configurações → Armazenamento*).

## Segurança

Proteções do servidor (`web/seguranca.cjs`), com painel em **/seguranca** (botão de escudo no topo):

- **Login:** senha comparada em tempo constante, 2º fator opcional (TOTP), bloqueio de 15 min após 5 erros por IP e atraso progressivo em ataques distribuídos.
- **Sessões no servidor:** expiram por tempo máximo e por inatividade; "Sair" invalida a sessão; cookie `HttpOnly`, `Secure`, `SameSite=Strict`, preso ao navegador de origem; login exigido em cada nova aba.
- **Cabeçalhos:** CSP restritiva (scripts só do próprio site, por hash), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, isolamento de origem, `Cache-Control: no-store` nos dados e bloqueio de indexação (`robots.txt` e `X-Robots-Tag`).
- **CSRF:** ações que alteram dados conferem `Origin`/`Sec-Fetch-Site`.
- **Arquivos:** a API só aceita caminhos dentro de `DATA_DIR` (bloqueia leitura de arquivos do sistema e `../`); uploads validados como PKCS#12 e gravados com permissão `600`; relatórios HTML abrem em sandbox.
- **Abuso:** limite de 600 requisições/min por sessão e de tamanho das requisições.
- **Auditoria:** logins, falhas, bloqueios e acessos negados em `DATA_DIR/logs/acessos.log`.

- **Dados sensíveis:** senhas de certificado cifradas pelo servidor (AES-256-GCM com chave mestra) antes de irem para o navegador; estado das empresas cifrado; nenhum segredo no código.
- **Robôs:** campo-armadilha e token de tempo no login; varredores (sqlmap, nikto...) e IPs que sondam falhas (`/.env`, `/wp-login.php`...) são banidos por 1 hora.
- **Entradas e respostas:** CNPJ, chaves, datas e competências validados; agendadores aceitam só campos permitidos; senhas removidas de respostas e logs; erros sem caminhos internos.
- **Dependências:** Dependabot semanal e verificação automática (`npm audit` + gitleaks) no GitHub; localmente, `npm run auditoria`.

A checklist completa de 20 itens fica em `/seguranca`. Recomendações: `APP_PASSWORD_HASH` no lugar de `APP_PASSWORD`, 2FA ativo, `CAPTADOR_CHAVE_MESTRA` definida e acesso sempre pelo domínio `https://`.

## Deploy no Railway

1. Em railway.app: **New Project → Deploy from GitHub repo** e escolha este repositório.
2. Em **Variables**, defina `APP_USER`, `APP_PASSWORD` e `DATA_DIR=/data` (opcional: `APP_TOTP_SECRET` para o 2FA).
3. Em **Settings → Volumes**, crie um volume montado em `/data` (para não perder certificados e notas).
4. Em **Settings → Networking**, clique em **Generate Domain**.

O build (`npm run build`) e o start (`npm start`) já estão no `railway.json`.
- O cadastro de empresas continua salvo no navegador (`localStorage`), como na versão desktop.

## Estrutura

```
captador-notas-fiscais/
├── assets/              # Ícones e logotipos
├── nfse/                # Integração NFS-e (ADN Nacional REST & Prefeitura SP SOAP)
├── sefaz/               # Integração SEFAZ (NFeDistribuicaoDFe, CT-e, manifestação, DANFE/DACTE)
├── src/                 # Interface React + Tailwind
│   └── utils/electronBridge.ts   # Ponte HTTP/SSE com o servidor
├── web/electronShim.cjs # Substituto do módulo electron para execução no servidor
├── main.cjs             # Handlers do backend (os mesmos do app desktop)
├── server.cjs           # Servidor web Express
└── vite.config.ts
```
