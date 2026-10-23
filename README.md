<div align="center">
  <img src="assets/logo.png" alt="Captador de Notas Fiscais" width="90" />
  <h1>Captador de Notas Fiscais — Versão Web</h1>
  <p>
    <strong>Captação automatizada de documentos fiscais eletrônicos (NF-e, NFC-e, CT-e e NFS-e) via Certificado Digital A1 (mTLS) e auditoria/apuração de DIFAL, agora acessível pelo navegador.</strong>
  </p>
</div>

---

## Sobre

O **Captador de Notas Fiscais** é a versão web do antigo aplicativo desktop (Electron) *CONT-AI*. Todas as funcionalidades foram mantidas:

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

- [Node.js](https://nodejs.org/) 18 LTS ou superior

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

As notas fiscais baixadas ficam em `<DATA_DIR>/sefaz_empresas` (ou na pasta escolhida em *Configurações → Armazenamento*).

## Segurança

- Por padrão o servidor só aceita conexões do próprio computador (`127.0.0.1`).
- **Não há login.** Antes de expor o servidor na rede (`HOST=0.0.0.0`) ou na internet, coloque-o atrás de uma camada de autenticação e HTTPS (por exemplo, um proxy reverso), pois ele dá acesso aos certificados digitais e às notas das empresas.
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
