// =========================================================================
// SHIM DO ELECTRON PARA EXECUÇÃO WEB
// -------------------------------------------------------------------------
// Substitui o módulo 'electron' quando o backend (main.cjs) roda dentro do
// servidor Express. Os handlers IPC continuam os mesmos; os recursos nativos
// (diálogos, shell, janela, bandeja) são traduzidos para o fluxo HTTP:
//   - dialog.showSaveDialog  -> grava em pasta temporária e vira download no navegador
//   - dialog.showOpenDialog  -> usa os caminhos enviados pelo navegador na requisição
//   - shell.openPath(arquivo) -> abre o arquivo (PDF) em nova aba do navegador
//   - shell.openPath(pasta)   -> abre a pasta no explorador do computador servidor
//   - webContents.send        -> evento enviado ao navegador via Server-Sent Events
// =========================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');

const APP_NAME = 'Captador de Notas Fiscais';
const APP_VERSION = '2.0.0';

const appDataRoot = process.env.APPDATA
  || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));

const userDataDir = process.env.DATA_DIR || path.join(appDataRoot, APP_NAME);
const tempDownloadsDir = path.join(os.tmpdir(), 'captador-notas-fiscais-downloads');
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(tempDownloadsDir, { recursive: true });

// Contexto da requisição HTTP em andamento (diálogos, downloads e arquivos a abrir)
const requestContext = new AsyncLocalStorage();

// Registro de handlers IPC e ouvintes de eventos enviados ao navegador
const ipcHandlers = new Map();
const eventListeners = new Set();

function broadcast(channel, payload) {
  for (const listener of eventListeners) {
    try { listener(channel, payload); } catch (_) {}
  }
}

function openLocally(target) {
  if (process.env.OPEN_FOLDERS === '0') return;
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [target], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch (_) {}
}

// Electron aceita (janela, opções) ou apenas (opções)
function pickOptions(a, b) {
  return (b && typeof b === 'object') ? b : (a && typeof a === 'object' && !a.__isShimWindow ? a : {});
}

const dialog = {
  async showSaveDialog(a, b) {
    const opts = pickOptions(a, b);
    const ctx = requestContext.getStore();
    if (!ctx) return { canceled: true };
    const filename = path.basename(String(opts.defaultPath || 'arquivo')).replace(/[<>:"/\\|?*]/g, '_') || 'arquivo';
    const folder = path.join(tempDownloadsDir, crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, filename);
    ctx.downloads.push({ filePath, filename, folder });
    return { canceled: false, filePath };
  },

  async showOpenDialog(a, b) {
    const ctx = requestContext.getStore();
    const paths = (ctx && Array.isArray(ctx.openPaths)) ? ctx.openPaths.filter(Boolean) : [];
    if (paths.length === 0) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: paths };
  },

  showMessageBox: async () => ({ response: 0 }),
  showErrorBox: () => {}
};

const shell = {
  async openPath(target) {
    const ctx = requestContext.getStore();
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        if (ctx) ctx.folders.push(target);
        openLocally(target);
      } else if (ctx) {
        ctx.opens.push(target);
      }
    } catch (_) {}
    return '';
  },
  showItemInFolder() {},
  openExternal: async () => {}
};

const webContents = {
  send(channel, payload) {
    broadcast(channel, payload);
  }
};

class BrowserWindow {
  constructor() {
    this.__isShimWindow = true;
    this.webContents = webContents;
  }
  static getAllWindows() { return []; }
  setMenu() {}
  on() {}
  loadURL() {}
  loadFile() {}
  isDestroyed() { return false; }
  isMinimized() { return false; }
  isVisible() { return true; }
  restore() {}
  show() {}
  hide() {}
  focus() {}
}

class Tray {
  setToolTip() {}
  setContextMenu() {}
  on() {}
}

class Notification {
  static isSupported() { return false; }
  show() {}
}

const Menu = {
  buildFromTemplate: () => ({}),
  setApplicationMenu: () => {}
};

const app = {
  getPath(name) {
    switch (name) {
      case 'userData': return userDataDir;
      case 'appData': return appDataRoot;
      case 'desktop': return path.join(os.homedir(), 'Desktop');
      case 'downloads': return tempDownloadsDir;
      case 'temp': return os.tmpdir();
      case 'home': return os.homedir();
      default: return userDataDir;
    }
  },
  getName: () => APP_NAME,
  getVersion: () => APP_VERSION,
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  on() {},
  quit() {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings() {}
};

const ipcMain = {
  handle(channel, fn) { ipcHandlers.set(channel, fn); },
  on() {},
  removeHandler(channel) { ipcHandlers.delete(channel); }
};

module.exports = {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
  Menu,
  Tray,
  // Exclusivos do servidor web
  __web: {
    APP_NAME,
    requestContext,
    ipcHandlers,
    eventListeners,
    tempDownloadsDir,
    userDataDir
  }
};
