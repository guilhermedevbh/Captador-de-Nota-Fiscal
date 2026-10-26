/**
 * Utilitários para parsing, validação de cadeia ICP-Brasil e formatação segura de datas de certificados A1.
 * Trata formatos: ISO (YYYY-MM-DD...), brasileiro (DD/MM/YYYY...), e timestamps.
 */

export function parseFlexibleDate(dateVal: any): Date | null {
  if (!dateVal) return null;
  if (dateVal instanceof Date) return isNaN(dateVal.getTime()) ? null : dateVal;
  const str = String(dateVal).trim();
  if (!str) return null;

  // Formato brasileiro DD/MM/YYYY ou DD/MM/YYYY HH:mm:ss
  const brMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (brMatch) {
    const day = parseInt(brMatch[1], 10);
    const month = parseInt(brMatch[2], 10) - 1;
    const year = parseInt(brMatch[3], 10);
    const hour = brMatch[4] ? parseInt(brMatch[4], 10) : 23;
    const min = brMatch[5] ? parseInt(brMatch[5], 10) : 59;
    const sec = brMatch[6] ? parseInt(brMatch[6], 10) : 59;
    const parsed = new Date(year, month, day, hour, min, sec);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  const direct = new Date(str);
  if (!isNaN(direct.getTime())) return direct;
  return null;
}

/**
 * Retorna os dias restantes para o vencimento do certificado.
 * Se a data for inválida ou não informada, retorna null.
 */
export function calculateDaysRemaining(dateVal: any): number | null {
  const d = parseFlexibleDate(dateVal);
  if (!d) return null;
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

/**
 * Formata data no padrão brasileiro DD/MM/YYYY com segurança (nunca retorna "Invalid Date").
 */
export function formatDateBr(dateVal: any, fallback = "N/D"): string {
  if (!dateVal) return fallback;
  const str = String(dateVal).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) return str;
  const d = parseFlexibleDate(dateVal);
  if (!d) return fallback;
  return d.toLocaleDateString("pt-BR");
}

/**
 * Converte qualquer valor de data em ISO; retorna "" se for inválido (nunca lança erro).
 */
export function dataIsoSegura(dateVal: any): string {
  const d = parseFlexibleDate(dateVal);
  return d ? d.toISOString() : "";
}
