// Cache em memória da leitura de cada XML (caminho + data de modificação + tamanho): abrir um mês de novo
// não relê nem reinterpreta os arquivos que não mudaram, só os novos ou alterados.
const fs = require('fs');

const LIMITE = 50000;
const cache = new Map();

function lerComCache(tipo, caminho, ler, stat) {
  let info = stat;
  if (!info) {
    try { info = fs.statSync(caminho); } catch (_) { return ler(); }
  }
  const chave = `${tipo}|${caminho}`;
  const item = cache.get(chave);
  let valor;
  if (item && item.mtimeMs === info.mtimeMs && item.size === info.size) {
    valor = item.valor;
  } else {
    valor = ler();
    if (cache.size >= LIMITE) cache.delete(cache.keys().next().value);
    cache.set(chave, { mtimeMs: info.mtimeMs, size: info.size, valor });
  }
  // Cópia rasa: quem chama pode completar o objeto (ex.: caminho do PDF) sem alterar o que está guardado
  return valor && typeof valor === 'object' ? { ...valor } : valor;
}

module.exports = { lerComCache };
