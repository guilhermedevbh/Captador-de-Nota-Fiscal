// =========================================================================
// RELATÓRIO EXCEL COMPLETO (.xlsx)
// -------------------------------------------------------------------------
// Lê todos os XMLs da empresa (NF-e, NFC-e, CT-e e NFS-e) e os eventos fiscais
// e gera a planilha no modelo:
//   Resumo Executivo | Notas Fiscais | Itens das Notas | Tributos Detalhados |
//   Pagamentos e Parcelas | Transportes | Eventos Fiscais |
//   Documentos Referenciados | Detalhes NFS-e | Inconsistências | Log da Consulta
// =========================================================================
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { XMLParser } = require('fast-xml-parser');
const { parseXmlNota } = require('../nfse/reportsNfse.cjs');
const { IBGE_MUNICIPIOS, IBGE_UF } = require('../nfse/ibge-municipios.cjs');

const ARRAY_TAGS = new Set(['det', 'dup', 'detPag', 'NFref', 'vol', 'Comp', 'infQ', 'infNF', 'infOutros', 'rastro', 'obsCont']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name, jpath) => ARRAY_TAGS.has(name) || /infDoc\.infNFe$/.test(jpath)
});

// ------------------------------------------------------------------
// Utilitários de leitura
// ------------------------------------------------------------------
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const digitos = (s) => String(s || '').replace(/\D/g, '');

function g(obj, caminho) {
  let cur = obj;
  for (const parte of caminho.split('.')) {
    if (cur == null) return '';
    cur = Array.isArray(cur) ? cur[0] : cur;
    cur = cur[parte];
  }
  if (cur == null) return '';
  if (typeof cur === 'object') return cur['#text'] != null ? String(cur['#text']) : '';
  return String(cur);
}

const num = (v) => {
  if (v === '' || v == null) return null;
  const x = Number(String(v).replace(',', '.'));
  return isNaN(x) ? null : x;
};
const n = (obj, caminho) => num(g(obj, caminho));

// Busca em largura o primeiro valor com uma das tags informadas
function busca(obj, ...nomes) {
  if (!obj || typeof obj !== 'object') return '';
  const fila = [obj];
  while (fila.length) {
    const atual = fila.shift();
    for (const nome of nomes) {
      if (atual[nome] != null && typeof atual[nome] !== 'object') return String(atual[nome]);
      if (atual[nome] && atual[nome]['#text'] != null) return String(atual[nome]['#text']);
    }
    for (const v of Object.values(atual)) if (v && typeof v === 'object') fila.push(...(Array.isArray(v) ? v : [v]));
  }
  return '';
}
const buscaN = (obj, ...nomes) => num(busca(obj, ...nomes));

function grupo(obj, prefixo) {
  if (!obj || typeof obj !== 'object') return { nome: '', dados: null };
  const chave = Object.keys(obj).find((k) => k.startsWith(prefixo));
  return chave ? { nome: chave, dados: obj[chave] } : { nome: '', dados: null };
}

// Data ISO (com fuso) -> Date com a hora local original (o Excel exibe exatamente a hora do XML)
function dt(str) {
  const m = String(str || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}
const isoData = (str) => (String(str || '').match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
const agoraBrasilia = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString();
const fmtCnpj = (doc) => {
  const d = digitos(doc);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc || '';
};
const fmtDataBr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const municipio = (cod) => IBGE_MUNICIPIOS[digitos(cod)] || '';
const ufDoMunicipio = (cod) => IBGE_UF[digitos(cod).slice(0, 2)] || '';
const soma = (...vals) => {
  const v = vals.filter((x) => x != null);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) * 100) / 100 : null;
};
const descr = (tabela, cod) => (cod === '' ? '' : tabela[cod] ? `${cod} - ${tabela[cod]}` : cod);

// ------------------------------------------------------------------
// Tabelas de códigos
// ------------------------------------------------------------------
const T = {
  tpNF: { 0: 'Entrada', 1: 'Saída' },
  finNFe: { 1: 'Normal', 2: 'Complementar', 3: 'Ajuste', 4: 'Devolução', 5: 'Nota de crédito', 6: 'Nota de débito' },
  tpAmb: { 1: 'Produção', 2: 'Homologação' },
  modFrete: { 0: 'Por conta do remetente (CIF)', 1: 'Por conta do destinatário (FOB)', 2: 'Por conta de terceiros', 3: 'Próprio por conta do remetente', 4: 'Próprio por conta do destinatário', 9: 'Sem frete' },
  tPag: { '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito', '05': 'Crédito loja', '10': 'Vale alimentação', '11': 'Vale refeição', '12': 'Vale presente', '13': 'Vale combustível', '15': 'Boleto bancário', '16': 'Depósito bancário', '17': 'PIX dinâmico', '18': 'Transferência / carteira digital', '19': 'Programa de fidelidade / cashback', '20': 'PIX estático', '21': 'Crédito em loja', '22': 'Pagamento eletrônico não informado', '90': 'Sem pagamento', '99': 'Outros' },
  modal: { '01': 'Rodoviário', '02': 'Aéreo', '03': 'Aquaviário', '04': 'Ferroviário', '05': 'Dutoviário', '06': 'Multimodal' },
  tpServ: { 0: 'Normal', 1: 'Subcontratação', 2: 'Redespacho', 3: 'Redespacho intermediário', 4: 'Serviço vinculado a multimodal' },
  tpCTe: { 0: 'Normal', 1: 'Complementar de valores', 2: 'Anulação', 3: 'Substituto' },
  opSimpNac: { 1: 'Não optante', 2: 'MEI', 3: 'ME/EPP (Simples Nacional)' },
  tpRetISSQN: { 1: 'Não retido', 2: 'Retido pelo tomador', 3: 'Retido pelo intermediário' },
  eventoNFe: { 110110: 'Carta de Correção', 110111: 'Cancelamento', 110112: 'Cancelamento por substituição', 210200: 'Confirmação da Operação', 210210: 'Ciência da Operação', 210220: 'Desconhecimento da Operação', 210240: 'Operação não Realizada' },
  eventoNFSe: { 101101: 'Cancelamento de NFS-e', 101103: 'Solicitação de Análise Fiscal para Cancelamento de NFS-e', 105102: 'Cancelamento de NFS-e por Substituição', 105104: 'Cancelamento de NFS-e Deferido por Análise Fiscal', 105105: 'Cancelamento de NFS-e Indeferido por Análise Fiscal', 202201: 'Confirmação do Prestador', 202205: 'Rejeição do Prestador', 203202: 'Confirmação do Tomador', 203206: 'Manifestação de NFS-e - Rejeição do Tomador', 204203: 'Confirmação do Intermediário', 204207: 'Rejeição do Intermediário', 205208: 'Anulação da Rejeição', 305101: 'Cancelamento de NFS-e por Ofício', 305102: 'Bloqueio de NFS-e por Ofício', 305103: 'Desbloqueio de NFS-e por Ofício' }
};
const CANCELAMENTO = new Set(['110111', '110112', '101101', '105102', '105104', '305101']);
const SUBSTITUICAO = new Set(['105102', '110112']);

// ------------------------------------------------------------------
// Colunas das abas (mesma ordem, títulos e larguras do modelo)
// tipo: t=texto, m=moeda, q=quantidade, p=percentual, h=data/hora, d=data, i=inteiro
// ------------------------------------------------------------------
const C = (header, key, width, tipo = 't') => ({ header, key, width, tipo });

const COLS_NOTAS = [
  C('Chave de acesso', 'chave', 54), C('Emitida / Recebida', 'direcao', 22), C('Tipo', 'tipo', 12), C('Modelo', 'modelo', 12),
  C('Série', 'serie', 12), C('Número', 'numero', 12), C('Data/hora emissão', 'dhEmi', 21, 'h'), C('Data/hora autorização', 'dhAut', 25, 'h'),
  C('Protocolo', 'protocolo', 13), C('Situação', 'situacao', 12), C('Data cancelamento', 'dataCanc', 21, 'h'),
  C('Chave vinculada (substituta/substituída)', 'chaveVinc', 44), C('Natureza da operação', 'natOp', 30), C('CFOP', 'cfop', 12),
  C('Tipo de operação', 'tipoOp', 20), C('Finalidade', 'finalidade', 14), C('Ambiente', 'ambiente', 12),
  C('CNPJ/CPF emitente', 'emitDoc', 21), C('Razão social emitente', 'emitNome', 36), C('IE/IM emitente', 'emitIe', 18),
  C('UF emitente', 'emitUf', 15), C('Município emitente', 'emitMun', 22), C('CNPJ/CPF destinatário / tomador', 'destDoc', 35),
  C('Nome destinatário / tomador', 'destNome', 36), C('IE/IM destinatário', 'destIe', 22), C('UF destinatário', 'destUf', 19),
  C('Município destinatário', 'destMun', 26), C('Valor produtos / serviços', 'vProd', 29, 'm'), C('Desconto', 'vDesc', 12, 'm'),
  C('Frete', 'vFrete', 12, 'm'), C('Seguro', 'vSeg', 12, 'm'), C('Outras despesas', 'vOutro', 19, 'm'), C('Base ICMS', 'vBC', 13, 'm'),
  C('ICMS', 'vICMS', 12, 'm'), C('Base ICMS ST', 'vBCST', 16, 'm'), C('ICMS ST', 'vST', 12, 'm'), C('FCP', 'vFCP', 12, 'm'),
  C('IPI', 'vIPI', 12, 'm'), C('PIS', 'vPIS', 12, 'm'), C('COFINS', 'vCOFINS', 12, 'm'), C('ISS', 'vISS', 12, 'm'), C('II', 'vII', 12, 'm'),
  C('Retenções', 'vRet', 13, 'm'), C('IBS', 'vIBS', 12, 'm'), C('CBS', 'vCBS', 12, 'm'), C('Tributos aproximados', 'vTotTrib', 24, 'm'),
  C('Valor total da nota', 'vNF', 23, 'm'), C('Qtd. itens', 'qtdItens', 14, 'i'), C('Fonte', 'fonte', 12), C('Informações complementares', 'infCpl', 60)
];

const COLS_ITENS = [
  C('Chave de acesso', 'chave', 54), C('Tipo', 'tipo', 12), C('Número', 'numero', 12), C('Série', 'serie', 12), C('Item', 'item', 12),
  C('Código / cód. tributação', 'codigo', 28), C('EAN', 'ean', 12), C('Descrição', 'descricao', 60), C('NCM / NBS', 'ncm', 13),
  C('CEST', 'cest', 12), C('CFOP / cód. municipal', 'cfop', 25), C('CST/CSOSN ICMS', 'cstIcms', 18), C('Unidade', 'unidade', 12),
  C('Quantidade', 'quantidade', 14, 'q'), C('Valor unitário', 'vUnit', 18, 'm'), C('Valor bruto', 'vBruto', 15, 'm'),
  C('Desconto', 'vDesc', 12, 'm'), C('Frete', 'vFrete', 12, 'm'), C('Outras despesas', 'vOutro', 19, 'm'), C('Situação', 'situacao', 12)
];

const COLS_TRIBUTOS = [
  C('Chave de acesso', 'chave', 54), C('Tipo', 'tipo', 12), C('Número', 'numero', 12), C('Item', 'item', 12), C('Tributo', 'tributo', 12),
  C('CST / tributação', 'cst', 20), C('Base de cálculo', 'base', 19, 'm'), C('Alíquota (%)', 'aliquota', 16, 'p'), C('Valor', 'valor', 12, 'm'),
  C('Situação', 'situacao', 12)
];

const COLS_PAGAMENTOS = [
  C('Chave de acesso', 'chave', 54), C('Tipo', 'tipo', 12), C('Número', 'numero', 12), C('Forma de pagamento', 'forma', 34),
  C('Parcela', 'parcela', 12), C('Vencimento', 'vencimento', 13, 'd'), C('Valor', 'valor', 14, 'm'), C('Observação', 'observacao', 30),
  C('Situação', 'situacao', 12)
];

const COLS_TRANSPORTES = [
  C('Chave de acesso', 'chave', 54), C('Tipo', 'tipo', 12), C('Número', 'numero', 12), C('Modalidade do frete / modal', 'modalidade', 30),
  C('CNPJ/CPF transportador', 'transpDoc', 22), C('Transportador', 'transpNome', 34), C('IE', 'ie', 14), C('UF', 'uf', 8),
  C('Município', 'municipio', 20), C('Placa', 'placa', 12), C('UF veículo', 'placaUf', 12), C('RNTRC', 'rntrc', 12),
  C('Qtd. volumes', 'qVol', 14, 'q'), C('Espécie / produto', 'especie', 24), C('Marca / quantidades', 'marca', 26),
  C('Peso líquido', 'pesoL', 14, 'q'), C('Peso bruto', 'pesoB', 14, 'q'), C('Valor da carga', 'vCarga', 16, 'm')
];

const COLS_EVENTOS = [
  C('Chave de acesso', 'chave', 54), C('Tipo', 'tipo', 12), C('Número', 'numero', 12), C('Código do evento', 'codigo', 20),
  C('Evento', 'evento', 40), C('Motivo / justificativa', 'motivo', 60), C('Data/hora', 'dataHora', 17, 'h'), C('Protocolo', 'protocolo', 16)
];

const COLS_REFERENCIADOS = [
  C('Chave de acesso', 'chave', 54), C('Tipo', 'tipo', 12), C('Número', 'numero', 12), C('Relação', 'relacao', 26),
  C('Chave / documento referenciado', 'referencia', 54), C('Motivo', 'motivo', 50)
];

const COLS_DETALHES_NFSE = [
  C('Chave de acesso', 'chave', 54), C('Número NFS-e', 'numero', 16), C('Nº DFS-e', 'nDFSe', 12), C('Série DPS', 'serieDps', 13),
  C('Número DPS', 'nDps', 14), C('Competência', 'competencia', 15, 'd'), C('Município de emissão', 'munEmissao', 24),
  C('Local da prestação', 'localPrestacao', 22), C('Município de incidência', 'munIncidencia', 27), C('Nome fantasia emitente', 'emitFant', 26),
  C('Regime (Simples Nacional)', 'regimeSN', 29), C('Regime especial', 'regimeEsp', 19), C('Logradouro emitente', 'emitLgr', 23),
  C('Número', 'emitNro', 12), C('Bairro', 'emitBairro', 12), C('Cód. IBGE município', 'emitCMun', 23), C('CEP', 'emitCep', 12),
  C('Telefone emitente', 'emitFone', 21), C('E-mail emitente', 'emitEmail', 19), C('Logradouro tomador', 'tomaLgr', 22),
  C('Número tomador', 'tomaNro', 18), C('Bairro tomador', 'tomaBairro', 18), C('Cód. IBGE tomador', 'tomaCMun', 21),
  C('CEP tomador', 'tomaCep', 15), C('Telefone tomador', 'tomaFone', 20), C('E-mail tomador', 'tomaEmail', 18),
  C('Cód. tributação nacional', 'cTribNac', 28), C('Cód. tributação municipal', 'cTribMun', 29), C('NBS', 'nbs', 12),
  C('Descrição do serviço', 'descricao', 60), C('Alíquota ISS (%)', 'aliqIss', 20, 'p'), C('Retenção ISS', 'retencaoIss', 16),
  C('IRRF retido', 'irrf', 15, 'm'), C('CSLL retida', 'csll', 15, 'm'), C('INSS/CP retido', 'inss', 18, 'm'), C('Valor líquido', 'vLiq', 17, 'm')
];

const COLS_INCONSISTENCIAS = [
  C('Chave / NSU / arquivo', 'ref', 60), C('Número', 'numero', 14), C('Tipo', 'tipo', 12), C('Descrição', 'descricao', 90)
];

const COLS_LOG = [C('Data/hora', 'dataHora', 17, 'h'), C('Mensagem', 'mensagem', 110)];

const FORMATOS = { m: '#,##0.00;[Red]-#,##0.00', q: '#,##0.####', p: '0.00##', h: 'dd/mm/yyyy hh:mm', d: 'dd/mm/yyyy', i: '0' };

// ------------------------------------------------------------------
// Eventos fiscais (NF-e, CT-e e NFS-e)
// ------------------------------------------------------------------
function extrairEvento(xml) {
  const doc = parser.parse(xml);
  // NFS-e Padrão Nacional: o código vem no nome do grupo (e101101, e105102...)
  const fila = [doc];
  let grupoEvento = null, codigo = '';
  while (fila.length && !grupoEvento) {
    const o = fila.shift();
    for (const [k, v] of Object.entries(o)) {
      const m = k.match(/^e(\d{6})$/);
      if (m && v && typeof v === 'object') { grupoEvento = v; codigo = m[1]; break; }
      if (v && typeof v === 'object') fila.push(...(Array.isArray(v) ? v : [v]));
    }
  }
  const chave = digitos(busca(doc, 'chNFSe', 'chNFe', 'chCTe'));
  codigo = codigo || busca(doc, 'tpEvento');
  if (!chave || !codigo) return null;
  const tipo = busca(doc, 'chNFSe') ? 'NFS-e' : busca(doc, 'chCTe') ? 'CT-e' : 'NF-e';
  const tabela = tipo === 'NFS-e' ? T.eventoNFSe : T.eventoNFe;
  return {
    chave, tipo, codigo,
    evento: busca(grupoEvento || doc, 'xDesc', 'descEvento') || tabela[codigo] || `Evento ${codigo}`,
    motivo: busca(grupoEvento || doc, 'xMotivo', 'xJust', 'xCorrecao') || '',
    dataHora: dt(busca(doc, 'dhEvento', 'dhProc', 'dhRegEvento')),
    protocolo: busca(doc, 'nProt', 'nDFe', 'nSeqEvento') || '',
    chaveSubstituta: digitos(busca(grupoEvento || {}, 'chSubstituta'))
  };
}

// ------------------------------------------------------------------
// NF-e / NFC-e
// ------------------------------------------------------------------
function extrairNFe(xml) {
  const doc = parser.parse(xml);
  const proc = doc.nfeProc || {};
  const nfe = proc.NFe || doc.NFe;
  const inf = nfe && nfe.infNFe;
  if (!inf) return null;

  const ide = inf.ide || {}, emit = inf.emit || {}, dest = inf.dest || {};
  const tot = inf.total || {}, icmsTot = tot.ICMSTot || {}, ibsTot = tot.IBSCBSTot || {}, ret = tot.retTrib || {};
  const transp = inf.transp || {}, cobr = inf.cobr || {}, pag = inf.pag || {}, infAdic = inf.infAdic || {};
  const prot = (proc.protNFe && proc.protNFe.infProt) || {};
  const chave = digitos(inf['@_Id']) || digitos(g(prot, 'chNFe'));
  const mod = g(ide, 'mod');
  const tipo = mod === '65' ? 'NFC-e' : 'NF-e';
  const emitDoc = digitos(g(emit, 'CNPJ') || g(emit, 'CPF'));
  const destDoc = digitos(g(dest, 'CNPJ') || g(dest, 'CPF')) || g(dest, 'idEstrangeiro');
  const dhEmi = g(ide, 'dhEmi') || g(ide, 'dEmi');
  const cStat = g(prot, 'cStat');
  const dets = arr(inf.det);
  const base = { chave, tipo, numero: g(ide, 'nNF'), serie: g(ide, 'serie') };

  const itens = [], tributos = [];
  const cfops = new Set();
  for (const det of dets) {
    const prod = det.prod || {}, imp = det.imposto || {};
    const item = g(det, '@_nItem');
    const icms = grupo(imp.ICMS, 'ICMS'), I = icms.dados || {};
    if (g(prod, 'CFOP')) cfops.add(g(prod, 'CFOP'));
    itens.push({
      ...base, item, codigo: g(prod, 'cProd'), ean: /^\d+$/.test(g(prod, 'cEAN')) ? g(prod, 'cEAN') : '', descricao: g(prod, 'xProd'),
      ncm: g(prod, 'NCM'), cest: g(prod, 'CEST'), cfop: g(prod, 'CFOP'), cstIcms: g(I, 'CST') || g(I, 'CSOSN'), unidade: g(prod, 'uCom'),
      quantidade: n(prod, 'qCom'), vUnit: n(prod, 'vUnCom'), vBruto: n(prod, 'vProd'), vDesc: n(prod, 'vDesc'), vFrete: n(prod, 'vFrete'),
      vOutro: n(prod, 'vOutro')
    });
    const trib = (tributo, cst, b, aliq, valor) => {
      if (valor == null && b == null) return;
      tributos.push({ ...base, item, tributo, cst, base: b, aliquota: aliq, valor });
    };
    if (icms.dados) {
      const cst = g(I, 'CST') || g(I, 'CSOSN');
      trib('ICMS', cst, n(I, 'vBC'), n(I, 'pICMS'), n(I, 'vICMS') ?? (n(I, 'vBC') != null ? 0 : null));
      if (g(I, 'vBCST') || g(I, 'vICMSST')) trib('ICMS ST', cst, n(I, 'vBCST'), n(I, 'pICMSST'), n(I, 'vICMSST'));
      if (g(I, 'vICMSSTRet')) trib('ICMS ST retido', cst, n(I, 'vBCSTRet'), n(I, 'pST'), n(I, 'vICMSSTRet'));
      if (g(I, 'vFCP')) trib('FCP', cst, n(I, 'vBCFCP'), n(I, 'pFCP'), n(I, 'vFCP'));
      if (g(I, 'vFCPST')) trib('FCP ST', cst, n(I, 'vBCFCPST'), n(I, 'pFCPST'), n(I, 'vFCPST'));
      if (g(I, 'vICMSMono')) trib('ICMS monofásico', cst, n(I, 'qBCMono'), n(I, 'adRemICMS'), n(I, 'vICMSMono'));
      if (g(I, 'vCredICMSSN')) trib('Crédito ICMS SN', cst, null, n(I, 'pCredSN'), n(I, 'vCredICMSSN'));
      if (g(I, 'vICMSDeson')) trib('ICMS desonerado', g(I, 'motDesICMS'), null, null, n(I, 'vICMSDeson'));
    }
    const uf = imp.ICMSUFDest;
    if (uf) {
      trib('DIFAL UF destino', '', n(uf, 'vBCUFDest'), n(uf, 'pICMSUFDest'), n(uf, 'vICMSUFDest'));
      if (g(uf, 'vFCPUFDest')) trib('FCP UF destino', '', n(uf, 'vBCFCPUFDest') ?? n(uf, 'vBCUFDest'), n(uf, 'pFCPUFDest'), n(uf, 'vFCPUFDest'));
    }
    const ipi = grupo(imp.IPI, 'IPI');
    if (ipi.dados) trib('IPI', g(ipi.dados, 'CST'), n(ipi.dados, 'vBC'), n(ipi.dados, 'pIPI'), n(ipi.dados, 'vIPI') ?? 0);
    if (imp.II) trib('II', '', n(imp.II, 'vBC'), null, n(imp.II, 'vII'));
    const pis = grupo(imp.PIS, 'PIS').dados, cofins = grupo(imp.COFINS, 'COFINS').dados;
    if (pis) trib('PIS', g(pis, 'CST'), n(pis, 'vBC'), n(pis, 'pPIS'), n(pis, 'vPIS') ?? 0);
    if (cofins) trib('COFINS', g(cofins, 'CST'), n(cofins, 'vBC'), n(cofins, 'pCOFINS'), n(cofins, 'vCOFINS') ?? 0);
    const ibs = imp.IBSCBS;
    if (ibs) {
      const gr = ibs.gIBSCBS || {}, cst = [g(ibs, 'CST'), g(ibs, 'cClassTrib')].filter(Boolean).join(' / ');
      trib('IBS', cst, n(gr, 'vBC'), soma(n(gr, 'gIBSUF.pIBSUF'), n(gr, 'gIBSMun.pIBSMun')), n(gr, 'vIBS') ?? soma(n(gr, 'gIBSUF.vIBSUF'), n(gr, 'gIBSMun.vIBSMun')));
      trib('CBS', cst, n(gr, 'vBC'), n(gr, 'gCBS.pCBS'), n(gr, 'gCBS.vCBS'));
    }
    if (imp.IS) trib('IS', g(imp.IS, 'CSTIS'), n(imp.IS, 'vBCIS'), n(imp.IS, 'pIS'), n(imp.IS, 'vIS'));
  }

  const detPag = arr(pag.detPag), dups = arr(cobr.dup);
  const pagamentos = [
    ...detPag.map((p) => ({
      ...base, forma: descr(T.tPag, g(p, 'tPag')) + (g(p, 'xPag') ? ` (${g(p, 'xPag')})` : ''), valor: n(p, 'vPag'),
      observacao: g(p, 'indPag') === '1' ? 'A prazo' : g(p, 'indPag') === '0' ? 'À vista' : ''
    })),
    ...dups.map((d) => ({
      ...base, forma: 'Duplicata', parcela: g(d, 'nDup'), vencimento: dt(g(d, 'dVenc')), valor: n(d, 'vDup'),
      observacao: g(cobr, 'fat.nFat') ? `Fatura ${g(cobr, 'fat.nFat')}` : ''
    }))
  ];

  const vols = arr(transp.vol), tr = transp.transporta || {};
  const somaVol = (campo) => (vols.length ? vols.reduce((s, v) => s + (n(v, campo) || 0), 0) : null);
  const temTransporte = g(transp, 'modFrete') !== '' && (g(transp, 'modFrete') !== '9' || vols.length || transp.transporta);
  const transportes = temTransporte ? [{
    ...base, modalidade: descr(T.modFrete, g(transp, 'modFrete')), transpDoc: digitos(g(tr, 'CNPJ') || g(tr, 'CPF')), transpNome: g(tr, 'xNome'),
    ie: g(tr, 'IE'), uf: g(tr, 'UF'), municipio: g(tr, 'xMun'), placa: g(transp, 'veicTransp.placa'), placaUf: g(transp, 'veicTransp.UF'),
    rntrc: g(transp, 'veicTransp.RNTC'), qVol: somaVol('qVol'), especie: [...new Set(vols.map((v) => g(v, 'esp')).filter(Boolean))].join(', '),
    marca: [...new Set(vols.map((v) => g(v, 'marca')).filter(Boolean))].join(', '), pesoL: somaVol('pesoL'), pesoB: somaVol('pesoB')
  }] : [];

  const referencias = arr(ide.NFref).map((r) => {
    if (g(r, 'refNFe')) return { ...base, relacao: 'Referencia NF-e', referencia: g(r, 'refNFe') };
    if (g(r, 'refCTe')) return { ...base, relacao: 'Referencia CT-e', referencia: g(r, 'refCTe') };
    if (r.refNF) return { ...base, relacao: 'Referencia NF modelo 1/1A', referencia: `${g(r, 'refNF.mod')} série ${g(r, 'refNF.serie')} nº ${g(r, 'refNF.nNF')} - ${fmtCnpj(g(r, 'refNF.CNPJ'))}` };
    if (r.refNFP) return { ...base, relacao: 'Referencia NF de produtor', referencia: `série ${g(r, 'refNFP.serie')} nº ${g(r, 'refNFP.nNF')}` };
    if (r.refECF) return { ...base, relacao: 'Referencia cupom fiscal', referencia: `ECF ${g(r, 'refECF.nECF')} COO ${g(r, 'refECF.nCOO')}` };
    return null;
  }).filter(Boolean);

  return {
    chave, tipo, data: isoData(dhEmi), emitDoc, destDoc, temProtocolo: !!cStat, cStat,
    nota: {
      ...base, modelo: mod, dhEmi: dt(dhEmi), dhAut: dt(g(prot, 'dhRecbto')), protocolo: g(prot, 'nProt'),
      natOp: g(ide, 'natOp'), cfop: [...cfops].join(', '), tipoOp: T.tpNF[g(ide, 'tpNF')] || '', finalidade: T.finNFe[g(ide, 'finNFe')] || '',
      ambiente: T.tpAmb[g(ide, 'tpAmb')] || '',
      emitDoc, emitNome: g(emit, 'xNome'), emitIe: g(emit, 'IE'), emitUf: g(emit, 'enderEmit.UF'), emitMun: g(emit, 'enderEmit.xMun'),
      destDoc, destNome: g(dest, 'xNome'), destIe: g(dest, 'IE'), destUf: g(dest, 'enderDest.UF'), destMun: g(dest, 'enderDest.xMun'),
      vProd: n(icmsTot, 'vProd'), vDesc: n(icmsTot, 'vDesc'), vFrete: n(icmsTot, 'vFrete'), vSeg: n(icmsTot, 'vSeg'), vOutro: n(icmsTot, 'vOutro'),
      vBC: n(icmsTot, 'vBC'), vICMS: n(icmsTot, 'vICMS'), vBCST: n(icmsTot, 'vBCST'), vST: n(icmsTot, 'vST'),
      vFCP: soma(n(icmsTot, 'vFCP'), n(icmsTot, 'vFCPST'), n(icmsTot, 'vFCPUFDest')), vIPI: n(icmsTot, 'vIPI'), vPIS: n(icmsTot, 'vPIS'),
      vCOFINS: n(icmsTot, 'vCOFINS'), vISS: n(tot, 'ISSQNtot.vISS'), vII: n(icmsTot, 'vII'),
      vRet: soma(n(ret, 'vRetPIS'), n(ret, 'vRetCOFINS'), n(ret, 'vRetCSLL'), n(ret, 'vIRRF'), n(ret, 'vRetPrev')),
      vIBS: n(ibsTot, 'gIBS.vIBS'), vCBS: n(ibsTot, 'gCBS.vCBS'), vTotTrib: n(icmsTot, 'vTotTrib'), vNF: n(icmsTot, 'vNF'),
      qtdItens: dets.length, fonte: tipo === 'NFC-e' ? 'SEFAZ-SP — XML completo (NFC-e)' : 'SEFAZ — XML completo (Distribuição DF-e)',
      infCpl: [g(infAdic, 'infAdFisco'), g(infAdic, 'infCpl')].filter(Boolean).join(' | ')
    },
    itens, tributos, pagamentos, transportes, referencias,
    somaItens: dets.reduce((s, d) => s + (n(d.prod, 'vProd') || 0), 0)
  };
}

// ------------------------------------------------------------------
// CT-e
// ------------------------------------------------------------------
function extrairCTe(xml) {
  const doc = parser.parse(xml);
  const proc = doc.cteProc || {};
  const cte = proc.CTe || doc.CTe;
  const inf = cte && cte.infCte;
  if (!inf) return null;

  const ide = inf.ide || {}, emit = inf.emit || {}, rem = inf.rem || {}, dest = inf.dest || {}, exped = inf.exped || {}, receb = inf.receb || {};
  const vPrest = inf.vPrest || {}, imp = inf.imp || {}, norm = inf.infCTeNorm || {}, carga = norm.infCarga || {};
  const prot = (proc.protCTe && proc.protCTe.infProt) || {};
  const icms = grupo(imp.ICMS, 'ICMS'), I = icms.dados || {};
  const dhEmi = g(ide, 'dhEmi');
  const chave = digitos(inf['@_Id']) || digitos(g(prot, 'chCTe'));
  const tomaCod = g(ide, 'toma3.toma') || g(ide, 'toma4.toma');
  const tomador = tomaCod === '4' ? (ide.toma4 || {}) : ({ 0: rem, 1: exped, 2: receb, 3: dest }[tomaCod] || dest);
  const enderToma = tomador.enderToma || tomador.enderReme || tomador.enderExped || tomador.enderReceb || tomador.enderDest || {};
  const base = { chave, tipo: 'CT-e', numero: g(ide, 'nCT'), serie: g(ide, 'serie') };
  const vTPrest = n(vPrest, 'vTPrest');
  const cst = g(I, 'CST');
  const emitDoc = digitos(g(emit, 'CNPJ') || g(emit, 'CPF'));
  const tomaDoc = digitos(g(tomador, 'CNPJ') || g(tomador, 'CPF'));

  const tributos = [];
  if (icms.dados) tributos.push({ ...base, item: '1', tributo: 'ICMS', cst, base: n(I, 'vBC'), aliquota: n(I, 'pICMS'), valor: n(I, 'vICMS') ?? 0 });
  if (g(imp, 'ICMSUFFim.vICMSUFFim')) tributos.push({ ...base, item: '1', tributo: 'DIFAL UF fim', cst, base: n(imp, 'ICMSUFFim.vBCUFFim'), aliquota: n(imp, 'ICMSUFFim.pICMSUFFim'), valor: n(imp, 'ICMSUFFim.vICMSUFFim') });
  const ibs = imp.IBSCBS;
  if (ibs) {
    const c = [g(ibs, 'CST'), g(ibs, 'cClassTrib')].filter(Boolean).join(' / ');
    tributos.push({ ...base, item: '1', tributo: 'IBS', cst: c, base: buscaN(ibs, 'vBC'), aliquota: soma(buscaN(ibs, 'pIBSUF'), buscaN(ibs, 'pIBSMun')), valor: buscaN(ibs, 'vIBS') });
    tributos.push({ ...base, item: '1', tributo: 'CBS', cst: c, base: buscaN(ibs, 'vBC'), aliquota: buscaN(ibs, 'pCBS'), valor: buscaN(ibs, 'vCBS') });
  }

  const chavesNFe = arr(norm.infDoc && norm.infDoc.infNFe).map((x) => g(x, 'chave')).filter(Boolean);
  const referencias = chavesNFe.map((k) => ({ ...base, relacao: 'Transporta a NF-e', referencia: k }));
  if (g(norm, 'infCteSub.chCte')) referencias.push({ ...base, relacao: 'Substitui o CT-e', referencia: g(norm, 'infCteSub.chCte') });
  if (g(inf, 'infCteComp.chCTe')) referencias.push({ ...base, relacao: 'Complementa o CT-e', referencia: g(inf, 'infCteComp.chCTe') });
  if (g(inf, 'infCteAnu.chCte')) referencias.push({ ...base, relacao: 'Anula o CT-e', referencia: g(inf, 'infCteAnu.chCte') });

  const qCarga = arr(carga.infQ);
  const pesos = qCarga.filter((q) => /peso/i.test(g(q, 'tpMed')));
  const pagamentos = arr(norm.cobr && norm.cobr.dup).map((d) => ({
    ...base, forma: 'Duplicata', parcela: g(d, 'nDup'), vencimento: dt(g(d, 'dVenc')), valor: n(d, 'vDup'),
    observacao: g(norm, 'cobr.fat.nFat') ? `Fatura ${g(norm, 'cobr.fat.nFat')}` : ''
  }));

  return {
    chave, tipo: 'CT-e', data: isoData(dhEmi), emitDoc, destDoc: tomaDoc, temProtocolo: !!g(prot, 'cStat'), cStat: g(prot, 'cStat'),
    nota: {
      ...base, modelo: '57', dhEmi: dt(dhEmi), dhAut: dt(g(prot, 'dhRecbto')), protocolo: g(prot, 'nProt'),
      natOp: g(ide, 'natOp'), cfop: g(ide, 'CFOP'), tipoOp: `Transporte — ${T.tpServ[g(ide, 'tpServ')] || 'Normal'}`,
      finalidade: T.tpCTe[g(ide, 'tpCTe')] || '', ambiente: T.tpAmb[g(ide, 'tpAmb')] || '',
      emitDoc, emitNome: g(emit, 'xNome'), emitIe: g(emit, 'IE'), emitUf: g(emit, 'enderEmit.UF'), emitMun: g(emit, 'enderEmit.xMun'),
      destDoc: tomaDoc, destNome: g(tomador, 'xNome'), destIe: g(tomador, 'IE'), destUf: g(enderToma, 'UF'), destMun: g(enderToma, 'xMun'),
      vProd: vTPrest, vBC: n(I, 'vBC'), vICMS: n(I, 'vICMS'), vIBS: ibs ? buscaN(ibs, 'vIBS') : null, vCBS: ibs ? buscaN(ibs, 'vCBS') : null,
      vTotTrib: n(imp, 'vTotTrib'), vNF: vTPrest, qtdItens: 1, fonte: 'SEFAZ — XML completo (Distribuição DF-e CT-e)', infCpl: g(inf, 'compl.xObs')
    },
    itens: [{
      ...base, item: '1', codigo: '',
      descricao: `Serviço de transporte ${g(ide, 'xMunIni')}/${g(ide, 'UFIni')} → ${g(ide, 'xMunFim')}/${g(ide, 'UFFim')}${g(carga, 'proPred') ? ` — ${g(carga, 'proPred')}` : ''}`,
      cfop: g(ide, 'CFOP'), cstIcms: cst, unidade: 'SV', quantidade: 1, vUnit: vTPrest, vBruto: vTPrest
    }],
    tributos, pagamentos, referencias,
    transportes: [{
      ...base, modalidade: T.modal[g(ide, 'modal')] || g(ide, 'modal'), transpDoc: emitDoc, transpNome: g(emit, 'xNome'),
      ie: g(emit, 'IE'), uf: g(emit, 'enderEmit.UF'), municipio: g(emit, 'enderEmit.xMun'), placa: busca(norm.infModal || {}, 'placa'),
      placaUf: busca(norm.infModal || {}, 'UF'), rntrc: busca(norm.infModal || {}, 'RNTRC'), especie: g(carga, 'proPred'),
      marca: qCarga.map((q) => `${g(q, 'tpMed')}: ${g(q, 'qCarga')}`).join('; '),
      pesoB: pesos.length ? pesos.reduce((s, q) => s + (n(q, 'qCarga') || 0), 0) : null, vCarga: n(carga, 'vCarga')
    }]
  };
}

// ------------------------------------------------------------------
// NFS-e (Padrão Nacional; o XML da Prefeitura de SP é convertido para o mesmo leiaute)
// ------------------------------------------------------------------
function extrairNFSe(xml, nomeArquivo) {
  if (/<infNFe[\s>]|<infCte[\s>]/.test(xml)) return null;
  const doc = parser.parse(xml);
  const inf = (doc.NFSe && doc.NFSe.infNFSe) || doc.infNFSe;
  const resumo = parseXmlNota(xml, nomeArquivo);
  if (!inf && !resumo) return null;
  if (!inf) return extrairNFSeSimplificada(resumo);

  const dps = (inf.DPS && inf.DPS.infDPS) || {};
  const emit = inf.emit || {}, prest = dps.prest || {}, toma = dps.toma || {}, serv = dps.serv || {};
  const val = dps.valores || {}, valNf = inf.valores || {};
  const tribMun = (val.trib && val.trib.tribMun) || {}, tribFed = (val.trib && val.trib.tribFed) || {}, pc = tribFed.piscofins || {};
  const ibs = inf.IBSCBS || dps.IBSCBS || null;
  const chave = digitos(String(inf['@_Id'] || '').replace(/^NFS/, '')) || digitos(busca(doc, 'ChaveNotaNacional'));
  const numero = g(inf, 'nNFSe') || (resumo && resumo.numeroNFe) || '';
  const dhEmi = g(dps, 'dhEmi') || g(inf, 'dhProc');
  const dCompet = g(dps, 'dCompet');
  const emitDoc = digitos(g(emit, 'CNPJ') || g(emit, 'CPF') || g(prest, 'CNPJ') || g(prest, 'CPF'));
  const tomaDoc = digitos(g(toma, 'CNPJ') || g(toma, 'CPF')) || g(toma, 'NIF');
  const emitCMun = g(emit, 'enderNac.cMun') || g(dps, 'cLocEmi');
  const tomaCMun = g(toma, 'end.endNac.cMun');
  const base = { chave, tipo: 'NFS-e', numero, serie: g(dps, 'serie') };
  const origemSp = /PORTAL_SP|prefeitura\.sp\.gov\.br/.test(xml);

  const vServ = n(val, 'vServPrest.vServ') ?? (resumo ? resumo.valorServicos : null);
  const vDesc = soma(n(val, 'vDescCondIncond.vDescIncond'), n(val, 'vDescCondIncond.vDescCond'));
  const vISS = n(valNf, 'vISSQN') ?? n(tribMun, 'vISSQN');
  const aliqIss = n(valNf, 'pAliqAplic') ?? n(tribMun, 'pAliq');
  const irrf = n(tribFed, 'vRetIRRF'), csll = n(tribFed, 'vRetCSLL'), inss = n(tribFed, 'vRetCP');
  const vIBS = ibs ? (buscaN(ibs, 'vIBSTot') ?? buscaN(ibs, 'vIBS') ?? soma(buscaN(ibs, 'vIBSUF'), buscaN(ibs, 'vIBSMun'))) : null;
  const vCBS = ibs ? buscaN(ibs, 'vCBS') : null;
  const tpRet = g(tribMun, 'tpRetISSQN');
  const vRet = n(valNf, 'vTotalRet') ?? soma(irrf, csll, inss, ['2', '3'].includes(tpRet) ? vISS : null);
  const totTrib = val.trib && val.trib.totTrib;

  const tributos = [];
  const trib = (tributo, cst, b, aliq, valor) => tributos.push({ ...base, item: '1', tributo, cst, base: b, aliquota: aliq, valor });
  if (vISS != null) trib('ISS', g(tribMun, 'tribISSQN'), n(valNf, 'vBC'), aliqIss, vISS);
  if (tribFed.piscofins) {
    trib('PIS', g(pc, 'CST'), n(pc, 'vBCPisCofins') ?? 0, n(pc, 'pAliqPis'), n(pc, 'vPis') ?? 0);
    trib('COFINS', g(pc, 'CST'), n(pc, 'vBCPisCofins') ?? 0, n(pc, 'pAliqCofins'), n(pc, 'vCofins') ?? 0);
  }
  if (irrf != null) trib('IRRF (retido)', '', null, null, irrf);
  if (csll != null) trib('CSLL (retida)', '', null, null, csll);
  if (inss != null) trib('INSS/CP (retido)', '', null, null, inss);
  if (ibs && (vIBS != null || vCBS != null)) {
    const cst = [busca(ibs, 'CST'), busca(ibs, 'cClassTrib')].filter(Boolean).join(' / ');
    const bc = buscaN(ibs, 'vBC');
    trib('IBS', cst, bc, soma(buscaN(ibs, 'pIBSUF'), buscaN(ibs, 'pIBSMun')), vIBS);
    trib('CBS', cst, bc, buscaN(ibs, 'pCBS'), vCBS);
  }

  const subst = dps.subst || null;
  const referencias = subst && g(subst, 'chSubstda')
    ? [{ ...base, relacao: 'Substitui a NFS-e', referencia: digitos(g(subst, 'chSubstda')), motivo: g(subst, 'xMotivo') }]
    : [];

  const vReceb = n(val, 'vServPrest.vReceb');
  const pagamentos = vReceb != null ? [{ ...base, forma: 'Valor recebido informado (não comprova liquidação)', valor: vReceb }] : [];

  return {
    chave, tipo: 'NFS-e', data: isoData(dhEmi) || isoData(dCompet), emitDoc, destDoc: tomaDoc,
    temProtocolo: !!(g(inf, 'nDFSe') || g(inf, 'cStat')), cStat: g(inf, 'cStat'), canceladaNoXml: !!(resumo && resumo.isCancelada),
    nota: {
      ...base, modelo: origemSp ? 'Prefeitura de São Paulo' : 'Padrão Nacional', dhEmi: dt(dhEmi), dhAut: dt(g(inf, 'dhProc')),
      protocolo: g(inf, 'nDFSe'), natOp: g(inf, 'xTribNac') || g(inf, 'xTribMun'), tipoOp: 'Prestação de serviço',
      ambiente: T.tpAmb[g(dps, 'tpAmb') || g(inf, 'ambGer')] || '', emitDoc, emitNome: g(emit, 'xNome'), emitIe: g(emit, 'IM') || g(prest, 'IM'),
      emitUf: g(emit, 'enderNac.UF') || ufDoMunicipio(emitCMun), emitMun: municipio(emitCMun) || g(inf, 'xLocEmi'),
      destDoc: tomaDoc, destNome: g(toma, 'xNome'), destIe: g(toma, 'IM'), destUf: tomaCMun ? ufDoMunicipio(tomaCMun) : '', destMun: municipio(tomaCMun),
      vProd: vServ, vDesc, vPIS: n(pc, 'vPis'), vCOFINS: n(pc, 'vCofins'), vISS, vRet, vIBS, vCBS,
      vTotTrib: totTrib && busca(totTrib, 'vTotTribFed') !== ''
        ? soma(buscaN(totTrib, 'vTotTribFed'), buscaN(totTrib, 'vTotTribEst'), buscaN(totTrib, 'vTotTribMun')) : null,
      vNF: vServ, qtdItens: 1, fonte: origemSp ? 'Prefeitura de São Paulo — Web Service' : 'ADN — XML completo', infCpl: busca(dps, 'xInfComp')
    },
    itens: [{
      ...base, item: '1', codigo: busca(serv, 'cTribNac'), descricao: busca(serv, 'xDescServ') || (resumo ? resumo.descricaoServico : ''),
      ncm: busca(serv, 'cNBS'), cfop: busca(serv, 'cTribMun'), quantidade: 1, vUnit: vServ, vBruto: vServ, vDesc
    }],
    tributos, pagamentos, transportes: [], referencias,
    detalhes: {
      chave, numero, nDFSe: g(inf, 'nDFSe'), serieDps: g(dps, 'serie'), nDps: g(dps, 'nDPS'), competencia: dt(dCompet),
      munEmissao: g(inf, 'xLocEmi'), localPrestacao: g(inf, 'xLocPrestacao'), munIncidencia: g(inf, 'xLocIncid'),
      emitFant: g(emit, 'xFant'), regimeSN: T.opSimpNac[g(prest, 'regTrib.opSimpNac')] || '', regimeEsp: g(prest, 'regTrib.regEspTrib'),
      emitLgr: g(emit, 'enderNac.xLgr'), emitNro: g(emit, 'enderNac.nro'), emitBairro: g(emit, 'enderNac.xBairro'), emitCMun,
      emitCep: g(emit, 'enderNac.CEP'), emitFone: g(emit, 'fone') || g(prest, 'fone'), emitEmail: g(emit, 'email') || g(prest, 'email'),
      tomaLgr: g(toma, 'end.xLgr'), tomaNro: g(toma, 'end.nro'), tomaBairro: g(toma, 'end.xBairro'), tomaCMun, tomaCep: g(toma, 'end.endNac.CEP'),
      tomaFone: g(toma, 'fone'), tomaEmail: g(toma, 'email'), cTribNac: busca(serv, 'cTribNac'), cTribMun: busca(serv, 'cTribMun'),
      nbs: busca(serv, 'cNBS'), descricao: busca(serv, 'xDescServ'), aliqIss, retencaoIss: T.tpRetISSQN[tpRet] || '',
      irrf, csll, inss, vLiq: n(valNf, 'vLiq')
    }
  };
}

// XML de NFS-e fora do leiaute nacional: usa os campos já interpretados pelo leitor de NFS-e
function extrairNFSeSimplificada(r) {
  const chave = digitos(r.chaveNotaNacional);
  const base = { chave, tipo: 'NFS-e', numero: r.numeroNFe, serie: r.dpsSerie };
  const dataIso = (String(r.dataGeracao || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/) || []).slice(1).reverse().join('-');
  return {
    chave, tipo: 'NFS-e', data: dataIso, emitDoc: digitos(r.prestadorCnpj), destDoc: digitos(r.tomadorCnpj), temProtocolo: true,
    canceladaNoXml: r.isCancelada, incompleto: true,
    nota: {
      ...base, modelo: r.origemCaptacao === 'PORTAL_SP' ? 'Prefeitura de São Paulo' : 'Outro leiaute', dhEmi: dt(dataIso), tipoOp: 'Prestação de serviço',
      emitDoc: digitos(r.prestadorCnpj), emitNome: r.prestadorNome, emitIe: r.prestadorIM === '-' ? '' : r.prestadorIM,
      destDoc: digitos(r.tomadorCnpj), destNome: r.tomadorNome, destIe: r.tomadorIM === '-' ? '' : r.tomadorIM,
      vProd: r.valorServicos, vISS: r.valorISSQN || null, vPIS: r.debitoPIS || null, vCOFINS: r.debitoCOFINS || null,
      vRet: soma(r.irrf || null, r.csll || null, r.inss || null), vNF: r.valorServicos, qtdItens: 1,
      fonte: r.origemCaptacao === 'PORTAL_SP' ? 'Prefeitura de São Paulo — Web Service' : 'XML NFS-e', infCpl: r.xInfComp === '-' ? '' : r.xInfComp
    },
    itens: [{ ...base, item: '1', descricao: r.descricaoServico, quantidade: 1, vUnit: r.valorServicos, vBruto: r.valorServicos }],
    tributos: r.valorISSQN ? [{ ...base, item: '1', tributo: 'ISS', base: r.baseCalculo, aliquota: r.aliqISSQN, valor: r.valorISSQN }] : [],
    pagamentos: [], transportes: [], referencias: []
  };
}

// ------------------------------------------------------------------
// Varredura e montagem
// ------------------------------------------------------------------
function listarXmls(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.xml')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const ehEvento = (nome, xml) =>
  /EVENTO/i.test(nome) || /<(procEventoNFe|procEventoCTe|eventoCTe|procEventoNFSe|pedRegEvento)[\s>]/.test(xml) ||
  (/<evento[\s>]/.test(xml) && !/<infNFe[\s>]|<infCte[\s>]|<infNFSe[\s>]/.test(xml));

function coletarDocumentos({ companyDir, cnpj, dataInicio, dataFim, direcao = 'todas', tipos, resumosSemXml = [] }) {
  const raizEmp = digitos(cnpj).slice(0, 8);
  const tiposOk = new Set(tipos && tipos.length ? tipos : ['NF-e', 'NFC-e', 'CT-e', 'NFS-e']);
  const log = [];
  const registrar = (mensagem) => log.push({ dataHora: dt(agoraBrasilia()), mensagem });
  const inconsistencias = [];
  registrar('Lendo os XMLs armazenados da empresa');

  const arquivos = listarXmls(companyDir);
  registrar(`${arquivos.length} arquivo(s) XML encontrado(s)`);

  const eventos = [];
  const pendentes = [];
  for (const arquivo of arquivos) {
    const rel = path.relative(companyDir, arquivo);
    let xml;
    try { xml = fs.readFileSync(arquivo, 'utf8'); } catch (e) {
      inconsistencias.push({ ref: rel, descricao: `Falha ao ler o arquivo: ${e.message}`, falha: true });
      continue;
    }
    if (ehEvento(path.basename(arquivo), xml)) {
      try { const ev = extrairEvento(xml); if (ev) eventos.push(ev); } catch (_) {}
    } else {
      pendentes.push({ rel, xml });
    }
  }
  const eventosPorChave = new Map();
  for (const ev of eventos) {
    if (!eventosPorChave.has(ev.chave)) eventosPorChave.set(ev.chave, []);
    eventosPorChave.get(ev.chave).push(ev);
  }
  registrar(`${eventos.length} evento(s) fiscal(is) lido(s)`);

  const docs = [];
  const vistos = new Set();
  for (const { rel, xml } of pendentes) {
    let d = null;
    try {
      // CT-e primeiro: ele também contém <infNFe> (chaves das NF-e transportadas)
      if (/<infCte[\s>]/.test(xml)) d = extrairCTe(xml);
      else if (/<infNFe[\s>]/.test(xml)) d = extrairNFe(xml);
      else d = extrairNFSe(xml, path.basename(rel));
    } catch (e) {
      inconsistencias.push({ ref: rel, descricao: `Falha na leitura do XML: ${e.message}`, falha: true });
      continue;
    }
    if (!d || !d.chave || vistos.has(d.chave)) continue;
    vistos.add(d.chave);
    d.cancelPasta = /CANCELAD/i.test(rel);
    docs.push(d);
  }

  // Situação, cancelamento, vínculos e direção (emitida/recebida)
  const docsPorChave = new Map(docs.map((d) => [d.chave, d]));
  for (const d of docs) {
    const evs = eventosPorChave.get(d.chave) || [];
    const canc = evs.find((e) => CANCELAMENTO.has(e.codigo));
    const subst = evs.find((e) => SUBSTITUICAO.has(e.codigo));
    let situacao = 'Autorizada';
    if (subst) situacao = 'Substituída';
    else if (canc || d.cancelPasta || d.canceladaNoXml) situacao = 'Cancelada';
    else if (['110', '301', '302', '303'].includes(d.cStat)) situacao = 'Denegada';
    else if (!d.temProtocolo) situacao = 'Sem protocolo';
    d.situacao = situacao;
    d.nota.situacao = situacao;
    d.nota.dataCanc = (subst || canc) ? (subst || canc).dataHora : null;
    const ref = d.referencias.find((r) => /^Substitui/.test(r.relacao));
    d.nota.chaveVinc = (subst && subst.chaveSubstituta) || (ref && ref.referencia) || '';
    if (subst && subst.chaveSubstituta && !d.referencias.some((r) => r.referencia === subst.chaveSubstituta)) {
      d.referencias.push({ chave: d.chave, tipo: d.tipo, numero: d.nota.numero, relacao: 'Substituída pela NFS-e', referencia: subst.chaveSubstituta, motivo: subst.motivo });
    }
    d.direcao = raizEmp && digitos(d.emitDoc).slice(0, 8) === raizEmp ? 'Emitida' : 'Recebida';
    d.nota.direcao = d.direcao;
  }

  // Filtros: tipos de documento, emitidas/recebidas e período (data de emissão)
  const filtrados = docs.filter((d) =>
    tiposOk.has(d.tipo) &&
    (direcao === 'todas' || (direcao === 'emitidas' ? d.direcao === 'Emitida' : d.direcao === 'Recebida')) &&
    (!dataInicio || (d.data && d.data >= dataInicio)) &&
    (!dataFim || (d.data && d.data <= dataFim))
  );
  filtrados.sort((a, b) => (a.nota.dhEmi || 0) - (b.nota.dhEmi || 0) || a.tipo.localeCompare(b.tipo) || Number(a.nota.numero) - Number(b.nota.numero));
  const chavesIncluidas = new Set(filtrados.map((d) => d.chave));

  // Verificações de consistência
  for (const d of filtrados) {
    const ref = { ref: d.chave, numero: d.nota.numero, tipo: d.tipo };
    if (d.incompleto) inconsistencias.push({ ...ref, descricao: 'XML fora do leiaute nacional: alguns campos não puderam ser detalhados.' });
    if (d.situacao === 'Sem protocolo') inconsistencias.push({ ...ref, descricao: 'Documento sem protocolo de autorização no XML.' });
    if (d.somaItens != null && d.nota.vProd != null && Math.abs(d.somaItens - d.nota.vProd) > 0.01) {
      inconsistencias.push({ ...ref, descricao: `Soma dos itens (${d.somaItens.toFixed(2)}) diferente do valor de produtos da nota (${d.nota.vProd.toFixed(2)}).` });
    }
    if (d.nota.vNF == null) inconsistencias.push({ ...ref, descricao: 'Valor total não informado no XML.' });
  }
  for (const ch of resumosSemXml) {
    inconsistencias.push({ ref: ch, numero: String(parseInt(ch.slice(25, 34), 10) || ''), tipo: 'NF-e', descricao: 'Somente resumo: NF-e manifestada, mas o XML completo ainda não foi liberado pela SEFAZ.', resumo: true });
  }

  const eventosIncluidos = eventos
    .filter((e) => chavesIncluidas.has(e.chave))
    .map((e) => ({ ...e, numero: docsPorChave.get(e.chave).nota.numero }))
    .sort((a, b) => (a.dataHora || 0) - (b.dataHora || 0));

  const contagem = {};
  for (const d of filtrados) contagem[d.tipo] = (contagem[d.tipo] || 0) + 1;
  registrar('Organizando informações');
  registrar(`${filtrados.length} documento(s) (${direcao === 'todas' ? 'emitidas e recebidas' : direcao}) no período: ${Object.entries(contagem).map(([t, q]) => `${t} ${q}`).join('; ') || 'nenhum'}; ${eventosIncluidos.length} evento(s).`);

  return {
    docs: filtrados,
    notas: filtrados.map((d) => d.nota),
    itens: filtrados.flatMap((d) => d.itens.map((i) => ({ ...i, situacao: d.situacao }))),
    tributos: filtrados.flatMap((d) => d.tributos.map((t) => ({ ...t, situacao: d.situacao }))),
    pagamentos: filtrados.flatMap((d) => d.pagamentos.map((p) => ({ ...p, situacao: d.situacao }))),
    transportes: filtrados.flatMap((d) => d.transportes),
    referencias: filtrados.flatMap((d) => d.referencias),
    detalhes: filtrados.filter((d) => d.detalhes).map((d) => d.detalhes),
    eventos: eventosIncluidos,
    inconsistencias,
    log
  };
}

// ------------------------------------------------------------------
// Escrita da planilha (formatação do modelo)
// ------------------------------------------------------------------
const AZUL = '001D4ED8';

function escreverAba(wb, nome, cols, linhas) {
  const ws = wb.addWorksheet(nome, { views: [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2', activeCell: 'A1' }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: '00FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  for (const l of linhas) {
    const row = ws.addRow(cols.map((c) => (l[c.key] === undefined || l[c.key] === '' ? null : l[c.key])));
    cols.forEach((c, i) => {
      if (FORMATOS[c.tipo] && row.getCell(i + 1).value != null) row.getCell(i + 1).numFmt = FORMATOS[c.tipo];
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(ws.rowCount, 1), column: cols.length } };
  return ws;
}

const somaCampo = (lista, campo) => Math.round(lista.reduce((s, x) => s + (Number(x[campo]) || 0), 0) * 100) / 100;

const NOMES_TIPO = { 'NF-e': 'NF-e (modelo 55)', 'NFC-e': 'NFC-e (modelo 65)', 'CT-e': 'CT-e (modelo 57)', 'NFS-e': 'NFS-e (Padrão Nacional — ADN)' };
const FONTES = {
  'NF-e': 'NF-e: SEFAZ Nacional, Distribuição DF-e por NSU com o certificado',
  'NFC-e': 'NFC-e: SEFAZ-SP, consulta das chaves autorizadas com o certificado',
  'CT-e': 'CT-e: SEFAZ Nacional, Distribuição DF-e por NSU com o certificado',
  'NFS-e': 'NFS-e: Ambiente de Dados Nacional (ADN), distribuição por NSU com o certificado (e Prefeitura de SP quando aplicável)'
};

function escreverResumo(wb, { razaoSocial, cnpj, dataInicio, dataFim, direcao, tipos, geradoPor, dados }) {
  const ws = wb.addWorksheet('Resumo Executivo');
  ws.columns = [{ width: 46 }, { width: 90 }];
  const titulo = { todas: 'RELATÓRIO DE NOTAS FISCAIS EMITIDAS E RECEBIDAS', emitidas: 'RELATÓRIO DE NOTAS FISCAIS EMITIDAS', recebidas: 'RELATÓRIO DE NOTAS FISCAIS RECEBIDAS' }[direcao];
  ws.addRow([titulo]).getCell(1).font = { bold: true, color: { argb: AZUL }, size: 14 };
  ws.addRow([]);

  const linha = (rotulo, valor, moeda = false) => {
    const r = ws.addRow([rotulo, valor]);
    r.getCell(1).font = { bold: true };
    if (moeda && typeof valor === 'number') r.getCell(2).numFmt = FORMATOS.m;
    r.getCell(2).alignment = { horizontal: 'left', wrapText: true };
  };
  const { docs, itens, inconsistencias } = dados;
  const tiposUsados = tipos && tipos.length ? tipos : ['NF-e', 'NFC-e', 'CT-e', 'NFS-e'];
  const agora = agoraBrasilia();

  linha('Empresa', razaoSocial || '');
  linha('CNPJ', fmtCnpj(cnpj));
  linha('Período inicial', dataInicio ? fmtDataBr(dataInicio) : 'Todos os períodos');
  linha('Período final', dataFim ? fmtDataBr(dataFim) : 'Todos os períodos');
  linha('Gerado em', `${fmtDataBr(agora.slice(0, 10))} ${agora.slice(11, 16)}`);
  linha('Gerado por', geradoPor || '');
  linha('Tipos de documento', tiposUsados.map((t) => NOMES_TIPO[t]).join('; '));
  linha('Fontes', tiposUsados.map((t) => FONTES[t]).join(' | '));
  ws.addRow([]);

  const validas = docs.filter((d) => d.situacao === 'Autorizada');
  linha('Notas incluídas', { todas: 'Emitidas e recebidas', emitidas: 'Emitidas (empresa como emitente/prestadora)', recebidas: 'Recebidas (empresa como destinatária/tomadora)' }[direcao]);
  linha('Total de documentos localizados', docs.length);
  linha('Emitidas', docs.filter((d) => d.direcao === 'Emitida').length);
  linha('Recebidas', docs.filter((d) => d.direcao === 'Recebida').length);
  linha('Autorizadas (válidas)', validas.length);
  linha('Canceladas', docs.filter((d) => d.situacao === 'Cancelada').length);
  linha('Substituídas', docs.filter((d) => d.situacao === 'Substituída').length);
  linha('Denegadas', docs.filter((d) => d.situacao === 'Denegada').length);
  linha('Outras situações (sem protocolo / não localizada)', docs.filter((d) => d.situacao === 'Sem protocolo').length);
  linha('Quantidade de itens', itens.length);
  ws.addRow([]);

  for (const t of tiposUsados) {
    const v = validas.filter((d) => d.tipo === t);
    linha(`${t} — documentos`, docs.filter((d) => d.tipo === t).length);
    linha(`${t} — valor total emitidas (válidas)`, somaCampo(v.filter((d) => d.direcao === 'Emitida').map((d) => d.nota), 'vNF'), true);
    linha(`${t} — valor total recebidas (válidas)`, somaCampo(v.filter((d) => d.direcao === 'Recebida').map((d) => d.nota), 'vNF'), true);
  }
  ws.addRow([]);

  const nv = validas.map((d) => d.nota);
  linha('Valor total das notas (válidas)', somaCampo(nv, 'vNF'), true);
  linha('Produtos / serviços (válidas)', somaCampo(nv, 'vProd'), true);
  linha('Descontos (válidas)', somaCampo(nv, 'vDesc'), true);
  linha('Frete (válidas)', somaCampo(nv, 'vFrete'), true);
  linha('ICMS (válidas)', somaCampo(nv, 'vICMS'), true);
  linha('ICMS ST (válidas)', somaCampo(nv, 'vST'), true);
  linha('FCP (válidas)', somaCampo(nv, 'vFCP'), true);
  linha('IPI (válidas)', somaCampo(nv, 'vIPI'), true);
  linha('PIS (válidas)', somaCampo(nv, 'vPIS'), true);
  linha('COFINS (válidas)', somaCampo(nv, 'vCOFINS'), true);
  linha('ISS (válidas)', somaCampo(nv, 'vISS'), true);
  linha('Retenções (válidas)', somaCampo(nv, 'vRet'), true);
  linha('IBS (válidas)', somaCampo(nv, 'vIBS'), true);
  linha('CBS (válidas)', somaCampo(nv, 'vCBS'), true);
  ws.addRow([]);

  linha('Documentos só com resumo (sem XML completo)', inconsistencias.filter((i) => i.resumo).length);
  linha('Documentos com dados incompletos', inconsistencias.filter((i) => !i.falha && !i.resumo).length);
  linha('Documentos com falha na leitura', inconsistencias.filter((i) => i.falha).length);
  linha('Abrangência da consulta', 'Notas captadas e armazenadas no período. NF-e e CT-e: últimos 90 dias disponíveis na SEFAZ. NFS-e: só municípios que compartilham com o ADN (e Prefeitura de SP).');
  linha('Observação', 'Canceladas, substituídas, denegadas e notas sem autorização não entram nos totais financeiros. Valores conforme os XMLs oficiais; nenhum valor foi estimado.');
  return ws;
}

async function gerarRelatorioExcel({ companyDir, cnpj, razaoSocial, dataInicio, dataFim, direcao = 'todas', tipos, geradoPor, resumosSemXml, filePath }) {
  const dados = coletarDocumentos({ companyDir, cnpj, dataInicio, dataFim, direcao, tipos, resumosSemXml });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Captador de Notas Fiscais';
  wb.created = new Date();

  escreverResumo(wb, { razaoSocial, cnpj, dataInicio, dataFim, direcao, tipos, geradoPor, dados });
  escreverAba(wb, 'Notas Fiscais', COLS_NOTAS, dados.notas);
  escreverAba(wb, 'Itens das Notas', COLS_ITENS, dados.itens);
  escreverAba(wb, 'Tributos Detalhados', COLS_TRIBUTOS, dados.tributos);
  escreverAba(wb, 'Pagamentos e Parcelas', COLS_PAGAMENTOS, dados.pagamentos);
  escreverAba(wb, 'Transportes', COLS_TRANSPORTES, dados.transportes);
  escreverAba(wb, 'Eventos Fiscais', COLS_EVENTOS, dados.eventos);
  escreverAba(wb, 'Documentos Referenciados', COLS_REFERENCIADOS, dados.referencias);
  escreverAba(wb, 'Detalhes NFS-e', COLS_DETALHES_NFSE, dados.detalhes);
  escreverAba(wb, 'Inconsistências', COLS_INCONSISTENCIAS, dados.inconsistencias);
  escreverAba(wb, 'Log da Consulta', COLS_LOG, dados.log);

  await wb.xlsx.writeFile(filePath);

  const porTipo = (t) => dados.docs.filter((d) => d.tipo === t).length;
  return {
    totalDocumentos: dados.docs.length,
    totalNotas: porTipo('NF-e') + porTipo('NFC-e'),
    totalItens: dados.itens.length,
    totalCtes: porTipo('CT-e'),
    totalNfses: porTipo('NFS-e'),
    totalEventos: dados.eventos.length
  };
}

module.exports = { gerarRelatorioExcel, coletarDocumentos };
