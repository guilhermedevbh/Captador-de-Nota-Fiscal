// Chave mestra de criptografia dos dados sensíveis (senhas de certificados e estado das empresas).
// Ordem: variável CAPTADOR_CHAVE_MESTRA (recomendado em produção) ou arquivo .chave-mestra
// gerado aleatoriamente na pasta de dados (permissão 600). Nunca fica no código-fonte.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let cache = null;

function pastaDados() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try { return require('electron').app.getPath('userData'); } catch (_) {}
  return process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.config', 'Captador de Notas Fiscais');
}

function obterChaveMestra() {
  if (cache) return cache;
  const env = process.env.CAPTADOR_CHAVE_MESTRA;
  if (env && env.length >= 16) {
    cache = crypto.createHash('sha256').update(env).digest();
    return cache;
  }
  const arquivo = path.join(pastaDados(), '.chave-mestra');
  try {
    if (fs.existsSync(arquivo)) {
      const salvo = Buffer.from(fs.readFileSync(arquivo, 'utf8').trim(), 'hex');
      if (salvo.length === 32) return (cache = salvo);
    }
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const nova = crypto.randomBytes(32);
    fs.writeFileSync(arquivo, nova.toString('hex'), { mode: 0o600 });
    return (cache = nova);
  } catch (err) {
    console.error('[Segurança] Não foi possível criar a chave mestra; defina CAPTADOR_CHAVE_MESTRA:', err.message);
    cache = crypto.createHash('sha256').update(`captador-${pastaDados()}`).digest();
    return cache;
  }
}

module.exports = { obterChaveMestra };
