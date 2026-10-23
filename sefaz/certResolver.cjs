const fs = require('fs');
const path = require('path');

// Pasta onde o servidor web guarda os certificados enviados pelo navegador
function pastaCertificados() {
  let base = process.env.DATA_DIR;
  if (!base) {
    try { base = require('electron').app.getPath('userData'); } catch (_) {}
  }
  return base ? path.join(base, 'certificados') : null;
}

// Localiza o certificado A1 mesmo quando o caminho salvo diverge do arquivo no disco
// (ex.: "certificado.pfx.pfx" x "certificado.pfx"). Retorna null se não houver arquivo.
function resolverCertificado(certPath, cnpj) {
  if (certPath && fs.existsSync(certPath)) return certPath;

  const dir = pastaCertificados();
  if (!dir || !fs.existsSync(dir)) return null;

  const arquivos = fs.readdirSync(dir).filter((f) => /\.(pfx|p12)$/i.test(f));
  const semExt = (n) => n.toLowerCase().replace(/(\.(pfx|p12))+$/i, '');
  const alvo = certPath ? semExt(path.basename(String(certPath))) : '';
  const cleanCnpj = String(cnpj || '').replace(/\D/g, '');

  const achado =
    (alvo && arquivos.find((f) => semExt(f) === alvo)) ||
    (cleanCnpj && arquivos.find((f) => f.replace(/\D/g, '').includes(cleanCnpj))) ||
    (arquivos.length === 1 ? arquivos[0] : null);

  return achado ? path.join(dir, achado) : null;
}

const MSG_CERT_AUSENTE =
  'O arquivo do certificado não está mais no servidor. Envie o certificado novamente em Configurações → Empresas. ' +
  'No Railway, confirme que existe um volume montado em /data para que ele não seja apagado a cada deploy.';

module.exports = { resolverCertificado, MSG_CERT_AUSENTE };
