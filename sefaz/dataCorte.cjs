// Data mínima de emissão para captação de documentos (padrão: 01/01/2026).
// Pode ser alterada pela variável de ambiente CAPTACAO_DATA_INICIAL (AAAA-MM-DD).
const DATA_INICIAL_CAPTACAO = /^\d{4}-\d{2}-\d{2}$/.test(process.env.CAPTACAO_DATA_INICIAL || '')
  ? process.env.CAPTACAO_DATA_INICIAL
  : '2026-01-01';

// Retorna true quando o documento foi emitido antes da data de corte.
// Usa a data de emissão (AAAA-MM-DD...) e, na falta dela, o AAMM da chave de acesso de 44 dígitos.
function antesDoCorte({ chave, data } = {}) {
  const m = String(data || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}` < DATA_INICIAL_CAPTACAO;
  const k = String(chave || '').replace(/\D/g, '');
  if (k.length === 44) return `20${k.slice(2, 4)}-${k.slice(4, 6)}` < DATA_INICIAL_CAPTACAO.slice(0, 7);
  return false;
}

module.exports = { DATA_INICIAL_CAPTACAO, antesDoCorte };
