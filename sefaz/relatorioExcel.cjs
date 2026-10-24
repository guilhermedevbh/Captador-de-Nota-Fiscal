// =========================================================================
// RELATÓRIO EXCEL COMPLETO (.xlsx)
// -------------------------------------------------------------------------
// Lê todos os XMLs da empresa (NF-e, NFC-e, CT-e e NFS-e) no período e gera
// uma planilha com abas de Resumo, Notas, Itens, Duplicatas, Pagamentos,
// CT-e e NFS-e contendo todos os campos fiscais relevantes de cada documento.
// =========================================================================
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { XMLParser } = require('fast-xml-parser');
const { parseXmlNota } = require('../nfse/reportsNfse.cjs');

const ARRAY_TAGS = new Set([
  'det', 'dup', 'detPag', 'NFref', 'vol', 'lacres', 'obsCont', 'obsFisco', 'procRef', 'autXML', 'rastro',
  'Comp', 'infQ', 'infNF', 'infOutros', 'infUnidTransp', 'ObsCont', 'ObsFisco', 'pass', 'infCTeComp'
]);

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

function n(obj, caminho) {
  const v = g(obj, caminho);
  if (v === '') return null;
  const num = Number(v.replace(',', '.'));
  return isNaN(num) ? null : num;
}

// Primeiro filho cujo nome começa com o prefixo (ex.: ICMS00, ICMSSN102, IPITrib)
function grupo(obj, prefixo) {
  if (!obj || typeof obj !== 'object') return { nome: '', dados: null };
  const chave = Object.keys(obj).find((k) => k.startsWith(prefixo));
  return chave ? { nome: chave, dados: obj[chave] } : { nome: '', dados: null };
}

// Data ISO (com fuso) -> Date em "horário local" para o Excel exibir a hora original
function dt(str) {
  const m = String(str || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}

function dtBr(str) {
  const m = String(str || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : dt(str);
}

const fmtCnpj = (doc) => {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc || '';
};

const docDe = (o) => fmtCnpj(g(o, 'CNPJ') || g(o, 'CPF')) || g(o, 'idEstrangeiro');
const fmtMoeda = (v) => (v == null ? '' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtData = (d) => (d ? d.toISOString().slice(0, 10).split('-').reverse().join('/') : '');
const desc = (tabela, cod) => (cod === '' ? '' : tabela[cod] ? `${cod} - ${tabela[cod]}` : cod);

// ------------------------------------------------------------------
// Tabelas de códigos
// ------------------------------------------------------------------
const T = {
  tpNF: { 0: 'Entrada', 1: 'Saída' },
  finNFe: { 1: 'Normal', 2: 'Complementar', 3: 'Ajuste', 4: 'Devolução', 5: 'Crédito', 6: 'Débito' },
  idDest: { 1: 'Interna', 2: 'Interestadual', 3: 'Exterior' },
  indFinal: { 0: 'Não', 1: 'Consumidor final' },
  indPres: { 0: 'Não se aplica', 1: 'Presencial', 2: 'Internet', 3: 'Teleatendimento', 4: 'Entrega em domicílio', 5: 'Presencial fora do estabelecimento', 9: 'Outros' },
  CRT: { 1: 'Simples Nacional', 2: 'Simples Nacional - excesso de sublimite', 3: 'Regime Normal', 4: 'MEI' },
  indIEDest: { 1: 'Contribuinte ICMS', 2: 'Contribuinte isento', 9: 'Não contribuinte' },
  modFrete: { 0: 'Por conta do remetente (CIF)', 1: 'Por conta do destinatário (FOB)', 2: 'Por conta de terceiros', 3: 'Próprio remetente', 4: 'Próprio destinatário', 9: 'Sem frete' },
  tPag: { '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito', '05': 'Crédito loja', '10': 'Vale alimentação', '11': 'Vale refeição', '12': 'Vale presente', '13': 'Vale combustível', '15': 'Boleto', '16': 'Depósito', '17': 'PIX', '18': 'Transferência/carteira digital', '19': 'Fidelidade/cashback', '20': 'PIX estático', '21': 'Crédito em loja', '22': 'Pagamento eletrônico não informado', '90': 'Sem pagamento', '99': 'Outros' },
  indPag: { 0: 'À vista', 1: 'A prazo' },
  orig: { 0: 'Nacional', 1: 'Estrangeira - importação direta', 2: 'Estrangeira - mercado interno', 3: 'Nacional - conteúdo importado 40% a 70%', 4: 'Nacional - processos produtivos básicos', 5: 'Nacional - conteúdo importado até 40%', 6: 'Estrangeira - importação direta sem similar', 7: 'Estrangeira - mercado interno sem similar', 8: 'Nacional - conteúdo importado acima de 70%' },
  modal: { '01': 'Rodoviário', '02': 'Aéreo', '03': 'Aquaviário', '04': 'Ferroviário', '05': 'Dutoviário', '06': 'Multimodal' },
  tpServ: { 0: 'Normal', 1: 'Subcontratação', 2: 'Redespacho', 3: 'Redespacho intermediário', 4: 'Serviço vinculado a multimodal' },
  tpCTe: { 0: 'Normal', 1: 'Complementar', 2: 'Anulação', 3: 'Substituto' },
  toma: { 0: 'Remetente', 1: 'Expedidor', 2: 'Recebedor', 3: 'Destinatário', 4: 'Outros' }
};

// ------------------------------------------------------------------
// Definição das colunas (tipo: t=texto, m=moeda, q=quantidade, p=percentual, d=data, h=data/hora, i=inteiro)
// ------------------------------------------------------------------
const C = (header, key, tipo = 't', width) => ({ header, key, tipo, width });

const COLS_NOTAS = [
  C('Operação p/ Empresa', 'operacao', 't', 18), C('Modelo', 'modelo', 't', 9), C('Situação', 'situacao', 't', 14),
  C('Chave de Acesso', 'chave', 't', 47), C('Número', 'numero', 'i', 11), C('Série', 'serie', 't', 7),
  C('Data Emissão', 'dhEmi', 'h', 17), C('Data Saída/Entrada', 'dhSaiEnt', 'h', 17), C('Competência', 'competencia', 't', 11),
  C('Natureza da Operação', 'natOp', 't', 34), C('Tipo NF', 'tpNF', 't', 12), C('Finalidade', 'finNFe', 't', 16),
  C('Destino da Operação', 'idDest', 't', 18), C('Consumidor Final', 'indFinal', 't', 18), C('Presença Comprador', 'indPres', 't', 22),
  C('Município Fato Gerador (IBGE)', 'cMunFG', 't', 14),
  C('Emitente CNPJ/CPF', 'emitDoc', 't', 20), C('Emitente IE', 'emitIE', 't', 16), C('Emitente IE ST', 'emitIEST', 't', 14),
  C('Emitente IM', 'emitIM', 't', 14), C('Emitente CNAE', 'emitCNAE', 't', 11), C('Emitente Regime (CRT)', 'emitCRT', 't', 24),
  C('Emitente Razão Social', 'emitNome', 't', 38), C('Emitente Nome Fantasia', 'emitFant', 't', 28),
  C('Emitente Logradouro', 'emitLgr', 't', 30), C('Emitente Número', 'emitNro', 't', 9), C('Emitente Bairro', 'emitBairro', 't', 20),
  C('Emitente Município', 'emitMun', 't', 22), C('Emitente UF', 'emitUF', 't', 6), C('Emitente CEP', 'emitCEP', 't', 10), C('Emitente Telefone', 'emitFone', 't', 14),
  C('Destinatário CNPJ/CPF', 'destDoc', 't', 20), C('Destinatário IE', 'destIE', 't', 16), C('Destinatário Ind. IE', 'destIndIE', 't', 22),
  C('Destinatário IM', 'destIM', 't', 14), C('Destinatário SUFRAMA', 'destSUFRAMA', 't', 12), C('Destinatário Razão Social', 'destNome', 't', 38),
  C('Destinatário Logradouro', 'destLgr', 't', 30), C('Destinatário Número', 'destNro', 't', 9), C('Destinatário Bairro', 'destBairro', 't', 20),
  C('Destinatário Município', 'destMun', 't', 22), C('Destinatário UF', 'destUF', 't', 6), C('Destinatário CEP', 'destCEP', 't', 10),
  C('Destinatário Telefone', 'destFone', 't', 14), C('Destinatário E-mail', 'destEmail', 't', 26),
  C('Qtd. Itens', 'qtdItens', 'i', 8), C('Valor Produtos', 'vProd', 'm'), C('Valor Frete', 'vFrete', 'm'), C('Valor Seguro', 'vSeg', 'm'),
  C('Valor Desconto', 'vDesc', 'm'), C('Outras Despesas', 'vOutro', 'm'), C('BC ICMS', 'vBC', 'm'), C('Valor ICMS', 'vICMS', 'm'),
  C('ICMS Desonerado', 'vICMSDeson', 'm'), C('Valor FCP', 'vFCP', 'm'), C('BC ICMS ST', 'vBCST', 'm'), C('Valor ICMS ST', 'vST', 'm'),
  C('FCP ST', 'vFCPST', 'm'), C('FCP ST Retido', 'vFCPSTRet', 'm'), C('ICMS Monofásico', 'vICMSMono', 'm'), C('ICMS Mono Retenção', 'vICMSMonoReten', 'm'),
  C('ICMS Mono Retido Ant.', 'vICMSMonoRet', 'm'), C('DIFAL FCP UF Dest.', 'vFCPUFDest', 'm'), C('DIFAL ICMS UF Dest.', 'vICMSUFDest', 'm'),
  C('DIFAL ICMS UF Remet.', 'vICMSUFRemet', 'm'), C('Valor II', 'vII', 'm'), C('Valor IPI', 'vIPI', 'm'), C('IPI Devolvido', 'vIPIDevol', 'm'),
  C('Valor PIS', 'vPIS', 'm'), C('Valor COFINS', 'vCOFINS', 'm'), C('Valor Serviços (ISSQN)', 'vServ', 'm'), C('Valor ISS', 'vISS', 'm'),
  C('Valor Total da Nota', 'vNF', 'm', 15), C('Tributos Aprox. (Lei 12.741)', 'vTotTrib', 'm'),
  C('BC IBS/CBS', 'vBCIBSCBS', 'm'), C('IBS UF', 'vIBSUF', 'm'), C('IBS Municipal', 'vIBSMun', 'm'), C('IBS Total', 'vIBS', 'm'),
  C('CBS', 'vCBS', 'm'), C('Imposto Seletivo', 'vIS', 'm'), C('Total NF c/ IBS/CBS/IS', 'vNFTot', 'm'),
  C('Ret. PIS', 'vRetPIS', 'm'), C('Ret. COFINS', 'vRetCOFINS', 'm'), C('Ret. CSLL', 'vRetCSLL', 'm'), C('BC IRRF', 'vBCIRRF', 'm'),
  C('Ret. IRRF', 'vIRRF', 'm'), C('BC Ret. Previdência', 'vBCRetPrev', 'm'), C('Ret. Previdência', 'vRetPrev', 'm'),
  C('Modalidade Frete', 'modFrete', 't', 28), C('Transportadora CNPJ/CPF', 'transpDoc', 't', 20), C('Transportadora Nome', 'transpNome', 't', 30),
  C('Transportadora IE', 'transpIE', 't', 14), C('Transportadora UF', 'transpUF', 't', 6), C('Veículo Placa', 'placa', 't', 10), C('Veículo UF', 'placaUF', 't', 6),
  C('Qtd. Volumes', 'qVol', 'q'), C('Espécie Volumes', 'esp', 't', 14), C('Peso Líquido (kg)', 'pesoL', 'q'), C('Peso Bruto (kg)', 'pesoB', 'q'),
  C('Fatura Número', 'nFat', 't', 12), C('Fatura Valor Original', 'fatOrig', 'm'), C('Fatura Desconto', 'fatDesc', 'm'), C('Fatura Valor Líquido', 'fatLiq', 'm'),
  C('Qtd. Duplicatas', 'qtdDup', 'i', 9), C('Duplicatas (nº | vencimento | valor)', 'duplicatas', 't', 50),
  C('Formas de Pagamento', 'formasPag', 't', 40), C('Valor Pago', 'vPagTot', 'm'), C('Troco', 'vTroco', 'm'),
  C('Intermediador CNPJ', 'intermCNPJ', 't', 20), C('Intermediador Identificação', 'intermId', 't', 20),
  C('NF-e Referenciadas', 'nfRef', 't', 47), C('Inf. Adicionais Fisco', 'infAdFisco', 't', 40), C('Informações Complementares', 'infCpl', 't', 60),
  C('Resp. Técnico CNPJ', 'respTecCNPJ', 't', 20), C('Resp. Técnico Nome', 'respTecNome', 't', 24),
  C('Protocolo', 'nProt', 't', 17), C('Data Autorização', 'dhRecbto', 'h', 17), C('Status SEFAZ', 'cStat', 't', 34), C('Arquivo XML', 'arquivo', 't', 50)
];

const COLS_ITENS = [
  C('Operação p/ Empresa', 'operacao', 't', 18), C('Modelo', 'modelo', 't', 9), C('Situação', 'situacao', 't', 14), C('Chave de Acesso', 'chave', 't', 47),
  C('Número', 'numero', 'i', 11), C('Série', 'serie', 't', 7), C('Data Emissão', 'dhEmi', 'h', 17), C('Natureza da Operação', 'natOp', 't', 30),
  C('Emitente CNPJ/CPF', 'emitDoc', 't', 20), C('Emitente Razão Social', 'emitNome', 't', 34), C('Emitente UF', 'emitUF', 't', 6),
  C('Destinatário CNPJ/CPF', 'destDoc', 't', 20), C('Destinatário Razão Social', 'destNome', 't', 34), C('Destinatário UF', 'destUF', 't', 6),
  C('Nº Item', 'nItem', 'i', 7), C('Código Produto', 'cProd', 't', 16), C('GTIN/EAN', 'cEAN', 't', 15), C('Descrição', 'xProd', 't', 45),
  C('NCM', 'NCM', 't', 10), C('NVE', 'NVE', 't', 8), C('CEST', 'CEST', 't', 9), C('Escala Relevante', 'indEscala', 't', 8), C('CNPJ Fabricante', 'CNPJFab', 't', 20),
  C('Benefício Fiscal', 'cBenef', 't', 11), C('EX TIPI', 'EXTIPI', 't', 7), C('CFOP', 'CFOP', 't', 7), C('Unidade Comercial', 'uCom', 't', 8),
  C('Qtd. Comercial', 'qCom', 'q'), C('Valor Unitário', 'vUnCom', 'q'), C('Valor Produto', 'vProd', 'm'), C('GTIN Tributável', 'cEANTrib', 't', 15),
  C('Unidade Tributável', 'uTrib', 't', 8), C('Qtd. Tributável', 'qTrib', 'q'), C('Valor Unit. Tributável', 'vUnTrib', 'q'),
  C('Frete', 'vFrete', 'm'), C('Seguro', 'vSeg', 'm'), C('Desconto', 'vDesc', 'm'), C('Outras Despesas', 'vOutro', 'm'), C('Compõe Total', 'indTot', 't', 8),
  C('Pedido de Compra', 'xPed', 't', 14), C('Item do Pedido', 'nItemPed', 't', 8), C('FCI', 'nFCI', 't', 20),
  C('Lotes (nº | validade | qtd)', 'lotes', 't', 30), C('Código ANP', 'cProdANP', 't', 12), C('Descrição ANP', 'descANP', 't', 26), C('Código ANVISA', 'cProdANVISA', 't', 15),
  C('Grupo ICMS', 'icmsGrupo', 't', 12), C('Origem', 'orig', 't', 34), C('CST/CSOSN ICMS', 'cstIcms', 't', 9), C('Mod. BC ICMS', 'modBC', 't', 7),
  C('% Redução BC', 'pRedBC', 'p'), C('BC ICMS', 'vBC', 'm'), C('Alíq. ICMS %', 'pICMS', 'p'), C('Valor ICMS', 'vICMS', 'm'),
  C('BC FCP', 'vBCFCP', 'm'), C('% FCP', 'pFCP', 'p'), C('Valor FCP', 'vFCP', 'm'),
  C('Mod. BC ST', 'modBCST', 't', 7), C('% MVA ST', 'pMVAST', 'p'), C('% Red. BC ST', 'pRedBCST', 'p'), C('BC ICMS ST', 'vBCST', 'm'),
  C('Alíq. ICMS ST %', 'pICMSST', 'p'), C('Valor ICMS ST', 'vICMSST', 'm'), C('BC FCP ST', 'vBCFCPST', 'm'), C('% FCP ST', 'pFCPST', 'p'), C('Valor FCP ST', 'vFCPST', 'm'),
  C('BC ST Retido', 'vBCSTRet', 'm'), C('% ST Consumidor', 'pST', 'p'), C('ICMS Substituto', 'vICMSSubstituto', 'm'), C('ICMS ST Retido', 'vICMSSTRet', 'm'),
  C('BC FCP ST Ret.', 'vBCFCPSTRet', 'm'), C('% FCP ST Ret.', 'pFCPSTRet', 'p'), C('FCP ST Retido', 'vFCPSTRet', 'm'),
  C('% Red. BC Efetiva', 'pRedBCEfet', 'p'), C('BC Efetiva', 'vBCEfet', 'm'), C('% ICMS Efetivo', 'pICMSEfet', 'p'), C('ICMS Efetivo', 'vICMSEfet', 'm'),
  C('ICMS Desonerado', 'vICMSDeson', 'm'), C('Motivo Desoneração', 'motDesICMS', 't', 9), C('% Diferimento', 'pDif', 'p'), C('ICMS Diferido', 'vICMSDif', 'm'),
  C('ICMS da Operação', 'vICMSOp', 'm'), C('% Crédito SN', 'pCredSN', 'p'), C('Crédito ICMS SN', 'vCredICMSSN', 'm'),
  C('Qtd. BC Monofásico', 'qBCMono', 'q'), C('Ad Rem ICMS', 'adRemICMS', 'q'), C('ICMS Monofásico', 'vICMSMono', 'm'),
  C('DIFAL BC UF Dest.', 'vBCUFDest', 'm'), C('DIFAL % FCP UF Dest.', 'pFCPUFDest', 'p'), C('DIFAL % ICMS UF Dest.', 'pICMSUFDest', 'p'),
  C('DIFAL % Interestadual', 'pICMSInter', 'p'), C('DIFAL FCP UF Dest.', 'vFCPUFDest', 'm'), C('DIFAL ICMS UF Dest.', 'vICMSUFDest', 'm'), C('DIFAL ICMS UF Remet.', 'vICMSUFRemet', 'm'),
  C('Enquadramento IPI', 'cEnq', 't', 8), C('CST IPI', 'cstIpi', 't', 7), C('BC IPI', 'vBCIPI', 'm'), C('Alíq. IPI %', 'pIPI', 'p'), C('Valor IPI', 'vIPI', 'm'),
  C('BC II', 'vBCII', 'm'), C('Despesas Aduaneiras', 'vDespAdu', 'm'), C('Valor II', 'vII', 'm'), C('Valor IOF', 'vIOF', 'm'),
  C('CST PIS', 'cstPis', 't', 7), C('BC PIS', 'vBCPIS', 'm'), C('Alíq. PIS %', 'pPIS', 'p'), C('Valor PIS', 'vPIS', 'm'),
  C('CST COFINS', 'cstCofins', 't', 7), C('BC COFINS', 'vBCCOFINS', 'm'), C('Alíq. COFINS %', 'pCOFINS', 'p'), C('Valor COFINS', 'vCOFINS', 'm'),
  C('CST IBS/CBS', 'cstIbsCbs', 't', 8), C('Classificação Trib. IBS/CBS', 'cClassTrib', 't', 12), C('BC IBS/CBS', 'vBCIBSCBS', 'm'),
  C('Alíq. IBS UF %', 'pIBSUF', 'p'), C('IBS UF', 'vIBSUF', 'm'), C('Alíq. IBS Mun. %', 'pIBSMun', 'p'), C('IBS Municipal', 'vIBSMun', 'm'), C('IBS Total', 'vIBS', 'm'),
  C('Alíq. CBS %', 'pCBS', 'p'), C('CBS', 'vCBS', 'm'), C('CST IS', 'cstIS', 't', 7), C('Class. Trib. IS', 'cClassTribIS', 't', 12),
  C('BC IS', 'vBCIS', 'm'), C('Alíq. IS %', 'pIS', 'p'), C('Imposto Seletivo', 'vIS', 'm'),
  C('Tributos Aprox. (Lei 12.741)', 'vTotTrib', 'm'), C('Inf. Adicionais do Produto', 'infAdProd', 't', 40)
];

const COLS_DUP = [
  C('Operação p/ Empresa', 'operacao', 't', 18), C('Modelo', 'modelo', 't', 9), C('Chave de Acesso', 'chave', 't', 47), C('Número NF', 'numero', 'i', 11),
  C('Data Emissão', 'dhEmi', 'h', 17), C('Emitente CNPJ/CPF', 'emitDoc', 't', 20), C('Emitente Razão Social', 'emitNome', 't', 34),
  C('Destinatário CNPJ/CPF', 'destDoc', 't', 20), C('Destinatário Razão Social', 'destNome', 't', 34),
  C('Fatura', 'nFat', 't', 12), C('Duplicata', 'nDup', 't', 10), C('Vencimento', 'dVenc', 'd', 12), C('Valor', 'vDup', 'm')
];

const COLS_PAG = [
  C('Operação p/ Empresa', 'operacao', 't', 18), C('Modelo', 'modelo', 't', 9), C('Chave de Acesso', 'chave', 't', 47), C('Número NF', 'numero', 'i', 11),
  C('Data Emissão', 'dhEmi', 'h', 17), C('Emitente Razão Social', 'emitNome', 't', 34), C('Indicador', 'indPag', 't', 10),
  C('Forma de Pagamento', 'tPag', 't', 30), C('Descrição', 'xPag', 't', 20), C('Valor', 'vPag', 'm'), C('Data Pagamento', 'dPag', 'd', 12),
  C('CNPJ Credenciadora', 'cnpjCard', 't', 20), C('Bandeira', 'tBand', 't', 8), C('Autorização', 'cAut', 't', 16)
];

const COLS_CTE = [
  C('Papel da Empresa', 'papel', 't', 20), C('Situação', 'situacao', 't', 14), C('Chave de Acesso', 'chave', 't', 47), C('Número', 'numero', 'i', 11),
  C('Série', 'serie', 't', 7), C('Data Emissão', 'dhEmi', 'h', 17), C('Competência', 'competencia', 't', 11), C('CFOP', 'CFOP', 't', 7),
  C('Natureza da Operação', 'natOp', 't', 30), C('Modal', 'modal', 't', 16), C('Tipo Serviço', 'tpServ', 't', 22), C('Tipo CT-e', 'tpCTe', 't', 14),
  C('Município Início', 'munIni', 't', 24), C('UF Início', 'UFIni', 't', 6), C('Município Fim', 'munFim', 't', 24), C('UF Fim', 'UFFim', 't', 6),
  C('Tomador do Serviço', 'tomaTipo', 't', 16), C('Tomador CNPJ/CPF', 'tomaDoc', 't', 20), C('Tomador Razão Social', 'tomaNome', 't', 34), C('Tomador UF', 'tomaUF', 't', 6),
  C('Emitente CNPJ', 'emitDoc', 't', 20), C('Emitente IE', 'emitIE', 't', 16), C('Emitente Razão Social', 'emitNome', 't', 34), C('Emitente Município', 'emitMun', 't', 22), C('Emitente UF', 'emitUF', 't', 6),
  C('Remetente CNPJ/CPF', 'remDoc', 't', 20), C('Remetente IE', 'remIE', 't', 16), C('Remetente Razão Social', 'remNome', 't', 34), C('Remetente Município', 'remMun', 't', 22), C('Remetente UF', 'remUF', 't', 6),
  C('Destinatário CNPJ/CPF', 'destDoc', 't', 20), C('Destinatário IE', 'destIE', 't', 16), C('Destinatário Razão Social', 'destNome', 't', 34), C('Destinatário Município', 'destMun', 't', 22), C('Destinatário UF', 'destUF', 't', 6),
  C('Expedidor CNPJ/CPF', 'expDoc', 't', 20), C('Expedidor Razão Social', 'expNome', 't', 30), C('Recebedor CNPJ/CPF', 'recDoc', 't', 20), C('Recebedor Razão Social', 'recNome', 't', 30),
  C('Valor Total Prestação', 'vTPrest', 'm', 15), C('Valor a Receber', 'vRec', 'm'), C('Componentes do Frete', 'componentes', 't', 45),
  C('Grupo ICMS', 'icmsGrupo', 't', 10), C('CST ICMS', 'cstIcms', 't', 7), C('% Redução BC', 'pRedBC', 'p'), C('BC ICMS', 'vBC', 'm'), C('Alíq. ICMS %', 'pICMS', 'p'),
  C('Valor ICMS', 'vICMS', 'm'), C('ICMS ST Retido', 'vICMSSTRet', 'm'), C('Crédito Presumido', 'vCred', 'm'), C('Indicador SN', 'indSN', 't', 7),
  C('DIFAL BC UF Fim', 'vBCUFFim', 'm'), C('DIFAL FCP UF Fim', 'vFCPUFFim', 'm'), C('DIFAL ICMS UF Fim', 'vICMSUFFim', 'm'), C('DIFAL ICMS UF Ini', 'vICMSUFIni', 'm'),
  C('IBS Total', 'vIBS', 'm'), C('CBS', 'vCBS', 'm'), C('Tributos Aprox. (Lei 12.741)', 'vTotTrib', 'm'),
  C('Valor da Carga', 'vCarga', 'm'), C('Produto Predominante', 'proPred', 't', 26), C('Outras Características', 'xOutCat', 't', 18),
  C('Quantidades da Carga', 'qCargas', 't', 34), C('RNTRC', 'RNTRC', 't', 12), C('Qtd. NF-e Vinculadas', 'qtdNFe', 'i', 9),
  C('Chaves NF-e Vinculadas', 'chavesNFe', 't', 47), C('Observações', 'xObs', 't', 50),
  C('Protocolo', 'nProt', 't', 17), C('Data Autorização', 'dhRecbto', 'h', 17), C('Status SEFAZ', 'cStat', 't', 30), C('Arquivo XML', 'arquivo', 't', 50)
];

const COLS_NFSE = [
  C('Tipo', 'tipo', 't', 12), C('Situação', 'situacao', 't', 12), C('Situação NFS-e', 'situacaoNFSe', 't', 24), C('Origem', 'origem', 't', 16),
  C('Chave NFS-e Nacional', 'chave', 't', 52), C('Número NFS-e', 'numero', 't', 12), C('Número DPS', 'dpsNumero', 't', 10), C('Série DPS', 'dpsSerie', 't', 7),
  C('Data Emissão', 'dataEmissao', 'd', 12), C('Competência', 'competencia', 't', 11),
  C('Prestador CNPJ/CPF', 'prestadorCnpj', 't', 20), C('Prestador Razão Social', 'prestadorNome', 't', 36), C('Prestador IM', 'prestadorIM', 't', 14),
  C('Prestador Simples Nacional', 'simplesNacional', 't', 30),
  C('Tomador CNPJ/CPF', 'tomadorCnpj', 't', 20), C('Tomador Razão Social', 'tomadorNome', 't', 36), C('Tomador IM', 'tomadorIM', 't', 14),
  C('Município de Incidência', 'munIncid', 't', 24), C('Código de Tributação', 'codTribNac', 't', 40), C('Item NBS', 'itemNBS', 't', 30),
  C('Descrição do Serviço', 'descricaoServico', 't', 60), C('Valor dos Serviços', 'valorServicos', 'm', 15), C('Desconto Incondicionado', 'descIncond', 'm'),
  C('Desconto Condicionado', 'descCond', 'm'), C('BC ISSQN', 'baseCalculo', 'm'), C('Alíq. ISSQN %', 'aliqISSQN', 'p'), C('Valor ISSQN', 'valorISSQN', 'm'),
  C('Tributação ISSQN', 'tributacaoISSQN', 't', 22), C('Retenção ISSQN', 'retencaoISSQN', 't', 24),
  C('Situação Trib. PIS/COFINS', 'sitTribPisCofins', 't', 30), C('BC PIS/COFINS', 'bcPisCofins', 'm'), C('Alíq. PIS %', 'aliqPIS', 'p'), C('Valor PIS', 'debitoPIS', 'm'),
  C('Alíq. COFINS %', 'aliqCOFINS', 'p'), C('Valor COFINS', 'debitoCOFINS', 'm'), C('Retenção Contrib. Sociais', 'descrContribSociaisRet', 't', 30),
  C('IRRF Retido', 'irrf', 'm'), C('CSLL Retida', 'csll', 'm'), C('INSS/CP Retido', 'inss', 'm'), C('Valor Líquido', 'valorLiquido', 'm', 15),
  C('Com Retenção', 'temRetencao', 't', 9),
  C('CST IBS/CBS', 'cstIbsCbs', 't', 20), C('Classificação Trib. IBS/CBS', 'classTribIbsCbs', 't', 30), C('Indicador da Operação', 'indicadorOperacao', 't', 30),
  C('BC IBS/CBS', 'bcIbsCbs', 'm'), C('Alíq. CBS %', 'aliqCBS', 'p'), C('Alíq. Efetiva CBS %', 'aliqEfetCBS', 'p'), C('CBS', 'valorCBSTotal', 'm'),
  C('Alíq. IBS UF %', 'aliqIBSEstadual', 'p'), C('IBS UF', 'valorIBSEstadual', 'm'), C('Alíq. IBS Mun. %', 'aliqIBSMunicipal', 'p'), C('IBS Municipal', 'valorIBSMunicipal', 'm'),
  C('IBS Total', 'valorIBSTotal', 'm'), C('% Tributos SN', 'percTotalTribSN', 'p'), C('Informações Complementares', 'xInfComp', 't', 50), C('Arquivo XML', 'arquivo', 't', 50)
];

const FORMATOS = { m: '#,##0.00', q: '#,##0.0000', p: '0.00##', d: 'dd/mm/yyyy', h: 'dd/mm/yyyy hh:mm', i: '0' };

// ------------------------------------------------------------------
// Extração NF-e / NFC-e
// ------------------------------------------------------------------
function papelNFe(cnpjEmp, emitDocRaw, destDocRaw) {
  if (cnpjEmp && emitDocRaw === cnpjEmp) return 'Saída (emitida)';
  if (cnpjEmp && destDocRaw === cnpjEmp) return 'Entrada (recebida)';
  return 'Terceiros';
}

function extrairNFe(xml, arquivo, cnpjEmp, cancelada) {
  const doc = parser.parse(xml);
  const proc = doc.nfeProc || {};
  const nfe = proc.NFe || doc.NFe;
  const inf = nfe && nfe.infNFe;
  if (!inf) return null;

  const ide = inf.ide || {}, emit = inf.emit || {}, dest = inf.dest || {};
  const tot = inf.total || {}, icmsTot = tot.ICMSTot || {}, ibsTot = tot.IBSCBSTot || {};
  const transp = inf.transp || {}, cobr = inf.cobr || {}, pag = inf.pag || {}, infAdic = inf.infAdic || {};
  const prot = (proc.protNFe && proc.protNFe.infProt) || {};
  const chave = String(inf['@_Id'] || '').replace(/\D/g, '') || g(prot, 'chNFe');
  const mod = g(ide, 'mod');
  const dhEmi = g(ide, 'dhEmi') || g(ide, 'dEmi');
  const emitRaw = (g(emit, 'CNPJ') || g(emit, 'CPF')).replace(/\D/g, '');
  const destRaw = (g(dest, 'CNPJ') || g(dest, 'CPF')).replace(/\D/g, '');
  const cStat = g(prot, 'cStat');
  const situacao = cancelada ? 'Cancelada' : ['110', '301', '302', '303'].includes(cStat) ? 'Denegada' : 'Autorizada';

  const base = {
    operacao: papelNFe(cnpjEmp, emitRaw, destRaw),
    modelo: mod === '65' ? 'NFC-e 65' : 'NF-e 55',
    situacao, chave,
    numero: n(ide, 'nNF'), serie: g(ide, 'serie'), dhEmi: dt(dhEmi), natOp: g(ide, 'natOp'),
    emitDoc: docDe(emit), emitNome: g(emit, 'xNome'), emitUF: g(emit, 'enderEmit.UF'),
    destDoc: docDe(dest), destNome: g(dest, 'xNome'), destUF: g(dest, 'enderDest.UF')
  };

  const vol = arr(transp.vol);
  const dups = arr(cobr.dup);
  const detPag = arr(pag.detPag);
  const dets = arr(inf.det);
  const somaVol = (campo) => (vol.length ? vol.reduce((s, v) => s + (n(v, campo) || 0), 0) : null);
  const transporta = transp.transporta || {};

  const nota = {
    ...base,
    dhSaiEnt: dt(g(ide, 'dhSaiEnt') || g(ide, 'dSaiEnt')),
    competencia: dhEmi.slice(0, 7),
    tpNF: desc(T.tpNF, g(ide, 'tpNF')), finNFe: desc(T.finNFe, g(ide, 'finNFe')), idDest: desc(T.idDest, g(ide, 'idDest')),
    indFinal: desc(T.indFinal, g(ide, 'indFinal')), indPres: desc(T.indPres, g(ide, 'indPres')), cMunFG: g(ide, 'cMunFG'),
    emitIE: g(emit, 'IE'), emitIEST: g(emit, 'IEST'), emitIM: g(emit, 'IM'), emitCNAE: g(emit, 'CNAE'), emitCRT: desc(T.CRT, g(emit, 'CRT')),
    emitFant: g(emit, 'xFant'), emitLgr: g(emit, 'enderEmit.xLgr'), emitNro: g(emit, 'enderEmit.nro'), emitBairro: g(emit, 'enderEmit.xBairro'),
    emitMun: g(emit, 'enderEmit.xMun'), emitCEP: g(emit, 'enderEmit.CEP'), emitFone: g(emit, 'enderEmit.fone'),
    destIE: g(dest, 'IE'), destIndIE: desc(T.indIEDest, g(dest, 'indIEDest')), destIM: g(dest, 'IM'), destSUFRAMA: g(dest, 'ISUF'),
    destLgr: g(dest, 'enderDest.xLgr'), destNro: g(dest, 'enderDest.nro'), destBairro: g(dest, 'enderDest.xBairro'),
    destMun: g(dest, 'enderDest.xMun'), destCEP: g(dest, 'enderDest.CEP'), destFone: g(dest, 'enderDest.fone'), destEmail: g(dest, 'email'),
    qtdItens: dets.length,
    vIBSUF: n(ibsTot, 'gIBS.gIBSUF.vIBSUF'), vIBSMun: n(ibsTot, 'gIBS.gIBSMun.vIBSMun'), vIBS: n(ibsTot, 'gIBS.vIBS'),
    vCBS: n(ibsTot, 'gCBS.vCBS'), vBCIBSCBS: n(ibsTot, 'vBCIBSCBS'), vIS: n(tot, 'ISTot.vIS'), vNFTot: n(tot, 'vNFTot'),
    vServ: n(tot, 'ISSQNtot.vServ'), vISS: n(tot, 'ISSQNtot.vISS'),
    vRetPIS: n(tot, 'retTrib.vRetPIS'), vRetCOFINS: n(tot, 'retTrib.vRetCOFINS'), vRetCSLL: n(tot, 'retTrib.vRetCSLL'),
    vBCIRRF: n(tot, 'retTrib.vBCIRRF'), vIRRF: n(tot, 'retTrib.vIRRF'), vBCRetPrev: n(tot, 'retTrib.vBCRetPrev'), vRetPrev: n(tot, 'retTrib.vRetPrev'),
    modFrete: desc(T.modFrete, g(transp, 'modFrete')), transpDoc: docDe(transporta), transpNome: g(transporta, 'xNome'),
    transpIE: g(transporta, 'IE'), transpUF: g(transporta, 'UF'), placa: g(transp, 'veicTransp.placa'), placaUF: g(transp, 'veicTransp.UF'),
    qVol: somaVol('qVol'), esp: vol.map((v) => g(v, 'esp')).filter(Boolean).join(', '), pesoL: somaVol('pesoL'), pesoB: somaVol('pesoB'),
    nFat: g(cobr, 'fat.nFat'), fatOrig: n(cobr, 'fat.vOrig'), fatDesc: n(cobr, 'fat.vDesc'), fatLiq: n(cobr, 'fat.vLiq'),
    qtdDup: dups.length,
    duplicatas: dups.map((d) => `${g(d, 'nDup')} | ${fmtData(dt(g(d, 'dVenc')))} | ${fmtMoeda(n(d, 'vDup'))}`).join('; '),
    formasPag: detPag.map((p) => `${desc(T.tPag, g(p, 'tPag'))}: ${fmtMoeda(n(p, 'vPag'))}`).join('; '),
    vPagTot: detPag.length ? detPag.reduce((s, p) => s + (n(p, 'vPag') || 0), 0) : null, vTroco: n(pag, 'vTroco'),
    intermCNPJ: fmtCnpj(g(inf, 'infIntermed.CNPJ')), intermId: g(inf, 'infIntermed.idCadIntTran'),
    nfRef: arr(ide.NFref).map((r) => g(r, 'refNFe') || g(r, 'refCTe')).filter(Boolean).join('; '),
    infAdFisco: g(infAdic, 'infAdFisco'), infCpl: g(infAdic, 'infCpl'),
    respTecCNPJ: fmtCnpj(g(inf, 'infRespTec.CNPJ')), respTecNome: g(inf, 'infRespTec.xContato'),
    nProt: g(prot, 'nProt'), dhRecbto: dt(g(prot, 'dhRecbto')), cStat: cStat ? `${cStat} - ${g(prot, 'xMotivo')}` : '', arquivo
  };
  for (const k of ['vBC', 'vICMS', 'vICMSDeson', 'vFCP', 'vBCST', 'vST', 'vFCPST', 'vFCPSTRet', 'vICMSMono', 'vICMSMonoReten', 'vICMSMonoRet',
    'vFCPUFDest', 'vICMSUFDest', 'vICMSUFRemet', 'vProd', 'vFrete', 'vSeg', 'vDesc', 'vII', 'vIPI', 'vIPIDevol', 'vPIS', 'vCOFINS', 'vOutro', 'vNF', 'vTotTrib']) {
    nota[k] = n(icmsTot, k);
  }

  const itens = dets.map((det) => {
    const prod = det.prod || {}, imp = det.imposto || {};
    const icms = grupo(imp.ICMS, 'ICMS'), I = icms.dados || {};
    const ipiTrib = grupo(imp.IPI, 'IPI'), ipi = ipiTrib.dados || {};
    const pis = grupo(imp.PIS, 'PIS').dados || {}, cofins = grupo(imp.COFINS, 'COFINS').dados || {};
    const uf = imp.ICMSUFDest || {}, ii = imp.II || {}, ibs = imp.IBSCBS || {}, gIBSCBS = ibs.gIBSCBS || {}, is = imp.IS || {};
    const item = { ...base, nItem: n(det, '@_nItem') };
    for (const k of ['cProd', 'cEAN', 'xProd', 'NCM', 'NVE', 'CEST', 'indEscala', 'cBenef', 'EXTIPI', 'CFOP', 'uCom', 'cEANTrib', 'uTrib', 'indTot', 'xPed', 'nItemPed', 'nFCI']) {
      item[k] = g(prod, k);
    }
    for (const k of ['qCom', 'vUnCom', 'vProd', 'qTrib', 'vUnTrib', 'vFrete', 'vSeg', 'vDesc', 'vOutro']) item[k] = n(prod, k);
    item.CNPJFab = fmtCnpj(g(prod, 'CNPJFab'));
    item.lotes = arr(prod.rastro).map((r) => `${g(r, 'nLote')} | ${fmtData(dt(g(r, 'dVal')))} | ${g(r, 'qLote')}`).join('; ');
    item.cProdANP = g(prod, 'comb.cProdANP'); item.descANP = g(prod, 'comb.descANP'); item.cProdANVISA = g(prod, 'med.cProdANVISA');
    item.icmsGrupo = icms.nome; item.orig = desc(T.orig, g(I, 'orig')); item.cstIcms = g(I, 'CST') || g(I, 'CSOSN');
    item.modBC = g(I, 'modBC'); item.modBCST = g(I, 'modBCST'); item.motDesICMS = g(I, 'motDesICMS');
    for (const k of ['pRedBC', 'vBC', 'pICMS', 'vICMS', 'vBCFCP', 'pFCP', 'vFCP', 'pMVAST', 'pRedBCST', 'vBCST', 'pICMSST', 'vICMSST', 'vBCFCPST', 'pFCPST', 'vFCPST',
      'vBCSTRet', 'pST', 'vICMSSubstituto', 'vICMSSTRet', 'vBCFCPSTRet', 'pFCPSTRet', 'vFCPSTRet', 'pRedBCEfet', 'vBCEfet', 'pICMSEfet', 'vICMSEfet',
      'vICMSDeson', 'pDif', 'vICMSDif', 'vICMSOp', 'pCredSN', 'vCredICMSSN', 'qBCMono', 'adRemICMS', 'vICMSMono']) {
      item[k] = n(I, k);
    }
    for (const k of ['vBCUFDest', 'pFCPUFDest', 'pICMSUFDest', 'pICMSInter', 'vFCPUFDest', 'vICMSUFDest', 'vICMSUFRemet']) item[k] = n(uf, k);
    item.cEnq = g(imp, 'IPI.cEnq'); item.cstIpi = g(ipi, 'CST'); item.vBCIPI = n(ipi, 'vBC'); item.pIPI = n(ipi, 'pIPI'); item.vIPI = n(ipi, 'vIPI');
    item.vBCII = n(ii, 'vBC'); item.vDespAdu = n(ii, 'vDespAdu'); item.vII = n(ii, 'vII'); item.vIOF = n(ii, 'vIOF');
    item.cstPis = g(pis, 'CST'); item.vBCPIS = n(pis, 'vBC'); item.pPIS = n(pis, 'pPIS'); item.vPIS = n(pis, 'vPIS');
    item.cstCofins = g(cofins, 'CST'); item.vBCCOFINS = n(cofins, 'vBC'); item.pCOFINS = n(cofins, 'pCOFINS'); item.vCOFINS = n(cofins, 'vCOFINS');
    item.cstIbsCbs = g(ibs, 'CST'); item.cClassTrib = g(ibs, 'cClassTrib'); item.vBCIBSCBS = n(gIBSCBS, 'vBC');
    item.pIBSUF = n(gIBSCBS, 'gIBSUF.pIBSUF'); item.vIBSUF = n(gIBSCBS, 'gIBSUF.vIBSUF');
    item.pIBSMun = n(gIBSCBS, 'gIBSMun.pIBSMun'); item.vIBSMun = n(gIBSCBS, 'gIBSMun.vIBSMun'); item.vIBS = n(gIBSCBS, 'vIBS');
    item.pCBS = n(gIBSCBS, 'gCBS.pCBS'); item.vCBS = n(gIBSCBS, 'gCBS.vCBS');
    item.cstIS = g(is, 'CSTIS'); item.cClassTribIS = g(is, 'cClassTribIS'); item.vBCIS = n(is, 'vBCIS'); item.pIS = n(is, 'pIS'); item.vIS = n(is, 'vIS');
    item.vTotTrib = n(imp, 'vTotTrib'); item.infAdProd = g(det, 'infAdProd');
    return item;
  });

  const duplicatas = dups.map((d) => ({
    ...base, nFat: g(cobr, 'fat.nFat'), nDup: g(d, 'nDup'), dVenc: dt(g(d, 'dVenc')), vDup: n(d, 'vDup')
  }));

  const pagamentos = detPag.map((p) => ({
    ...base, indPag: desc(T.indPag, g(p, 'indPag')), tPag: desc(T.tPag, g(p, 'tPag')), xPag: g(p, 'xPag'), vPag: n(p, 'vPag'),
    dPag: dt(g(p, 'dPag')), cnpjCard: fmtCnpj(g(p, 'card.CNPJ')), tBand: g(p, 'card.tBand'), cAut: g(p, 'card.cAut')
  }));

  return { nota, itens, duplicatas, pagamentos, data: dhEmi };
}

// ------------------------------------------------------------------
// Extração CT-e
// ------------------------------------------------------------------
function extrairCTe(xml, arquivo, cnpjEmp, cancelada) {
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

  const tomaCod = g(ide, 'toma3.toma') || g(ide, 'toma4.toma') || g(ide, 'toma');
  const partes = { 0: rem, 1: exped, 2: receb, 3: dest };
  const tomador = tomaCod === '4' ? (ide.toma4 || {}) : (partes[tomaCod] || {});
  const ender = (o) => o.enderReme || o.enderDest || o.enderExped || o.enderReceb || o.enderToma || o.enderEmit || {};

  const raw = (o) => (g(o, 'CNPJ') || g(o, 'CPF')).replace(/\D/g, '');
  const papeis = [];
  if (cnpjEmp) {
    if (raw(emit) === cnpjEmp) papeis.push('Emitente');
    if (raw(tomador) === cnpjEmp) papeis.push('Tomador');
    if (raw(rem) === cnpjEmp) papeis.push('Remetente');
    if (raw(dest) === cnpjEmp) papeis.push('Destinatário');
    if (raw(exped) === cnpjEmp) papeis.push('Expedidor');
    if (raw(receb) === cnpjEmp) papeis.push('Recebedor');
  }
  const chavesNFe = arr(norm.infDoc && norm.infDoc.infNFe).map((x) => g(x, 'chave')).filter(Boolean);
  const cStat = g(prot, 'cStat');

  return {
    data: dhEmi,
    cte: {
      papel: papeis.join(' / ') || 'Terceiros', situacao: cancelada ? 'Cancelada' : 'Autorizada',
      chave: String(inf['@_Id'] || '').replace(/\D/g, '') || g(prot, 'chCTe'),
      numero: n(ide, 'nCT'), serie: g(ide, 'serie'), dhEmi: dt(dhEmi), competencia: dhEmi.slice(0, 7), CFOP: g(ide, 'CFOP'), natOp: g(ide, 'natOp'),
      modal: desc(T.modal, g(ide, 'modal')), tpServ: desc(T.tpServ, g(ide, 'tpServ')), tpCTe: desc(T.tpCTe, g(ide, 'tpCTe')),
      munIni: g(ide, 'xMunIni'), UFIni: g(ide, 'UFIni'), munFim: g(ide, 'xMunFim'), UFFim: g(ide, 'UFFim'),
      tomaTipo: T.toma[tomaCod] || '', tomaDoc: docDe(tomador), tomaNome: g(tomador, 'xNome'), tomaUF: g(ender(tomador), 'UF'),
      emitDoc: docDe(emit), emitIE: g(emit, 'IE'), emitNome: g(emit, 'xNome'), emitMun: g(emit, 'enderEmit.xMun'), emitUF: g(emit, 'enderEmit.UF'),
      remDoc: docDe(rem), remIE: g(rem, 'IE'), remNome: g(rem, 'xNome'), remMun: g(rem, 'enderReme.xMun'), remUF: g(rem, 'enderReme.UF'),
      destDoc: docDe(dest), destIE: g(dest, 'IE'), destNome: g(dest, 'xNome'), destMun: g(dest, 'enderDest.xMun'), destUF: g(dest, 'enderDest.UF'),
      expDoc: docDe(exped), expNome: g(exped, 'xNome'), recDoc: docDe(receb), recNome: g(receb, 'xNome'),
      vTPrest: n(vPrest, 'vTPrest'), vRec: n(vPrest, 'vRec'),
      componentes: arr(vPrest.Comp).map((c) => `${g(c, 'xNome')}: ${fmtMoeda(n(c, 'vComp'))}`).join('; '),
      icmsGrupo: icms.nome, cstIcms: g(I, 'CST'), pRedBC: n(I, 'pRedBC'), vBC: n(I, 'vBC'), pICMS: n(I, 'pICMS'), vICMS: n(I, 'vICMS'),
      vICMSSTRet: n(I, 'vICMSSTRet'), vCred: n(I, 'vCred'), indSN: g(I, 'indSN'),
      vBCUFFim: n(imp, 'ICMSUFFim.vBCUFFim'), vFCPUFFim: n(imp, 'ICMSUFFim.vFCPUFFim'), vICMSUFFim: n(imp, 'ICMSUFFim.vICMSUFFim'), vICMSUFIni: n(imp, 'ICMSUFFim.vICMSUFIni'),
      vIBS: n(imp, 'IBSCBS.gIBSCBS.vIBS'), vCBS: n(imp, 'IBSCBS.gIBSCBS.gCBS.vCBS'), vTotTrib: n(imp, 'vTotTrib'),
      vCarga: n(carga, 'vCarga'), proPred: g(carga, 'proPred'), xOutCat: g(carga, 'xOutCat'),
      qCargas: arr(carga.infQ).map((q) => `${g(q, 'tpMed')}: ${g(q, 'qCarga')}`).join('; '),
      RNTRC: g(norm, 'infModal.rodo.RNTRC'), qtdNFe: chavesNFe.length, chavesNFe: chavesNFe.join('; '),
      xObs: g(inf, 'compl.xObs'), nProt: g(prot, 'nProt'), dhRecbto: dt(g(prot, 'dhRecbto')),
      cStat: cStat ? `${cStat} - ${g(prot, 'xMotivo')}` : '', arquivo
    }
  };
}

// ------------------------------------------------------------------
// Extração NFS-e (reaproveita o leitor de NFS-e Nacional / Prefeitura SP)
// ------------------------------------------------------------------
function extrairNFSe(xml, arquivo, cnpjEmp) {
  const nota = parseXmlNota(xml, path.basename(arquivo));
  if (!nota) return null;
  const prest = String(nota.prestadorCnpj || '').replace(/\D/g, '');
  const toma = String(nota.tomadorCnpj || '').replace(/\D/g, '');
  const tipo = cnpjEmp && prest === cnpjEmp ? 'Prestada' : cnpjEmp && toma === cnpjEmp ? 'Tomada' : 'Terceiros';
  const dataEmissao = dtBr(nota.dataGeracao);
  const mComp = String(nota.competencia || '').match(/^(\d{2})\/(\d{4})$/);
  const competencia = mComp ? `${mComp[2]}-${mComp[1]}` : '';
  const vazio = (v) => (v === '' || v === '-' ? null : v);
  return {
    data: competencia ? `${competencia}-01` : dataEmissao ? dataEmissao.toISOString() : '',
    nfse: {
      ...nota, tipo, origem: nota.origemCaptacao === 'PORTAL_SP' ? 'Prefeitura SP' : 'Portal Nacional',
      chave: nota.chaveNotaNacional, numero: nota.numeroNFe, dataEmissao, competencia,
      temRetencao: nota.temRetencao ? 'Sim' : 'Não', xInfComp: vazio(nota.xInfComp),
      bcIbsCbs: vazio(nota.bcIbsCbs), aliqCBS: vazio(nota.aliqCBS), aliqEfetCBS: vazio(nota.aliqEfetCBS), valorCBSTotal: vazio(nota.valorCBSTotal),
      aliqIBSEstadual: vazio(nota.aliqIBSEstadual), valorIBSEstadual: vazio(nota.valorIBSEstadual), aliqIBSMunicipal: vazio(nota.aliqIBSMunicipal),
      valorIBSMunicipal: vazio(nota.valorIBSMunicipal), valorIBSTotal: vazio(nota.valorIBSTotal), arquivo
    }
  };
}

// ------------------------------------------------------------------
// Varredura dos XMLs da empresa
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

function noPeriodo(data, ano, mes) {
  const m = String(data || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return !ano || ano === 'todos';
  if (ano && ano !== 'todos' && m[1] !== String(ano)) return false;
  if (mes && mes !== 'todos' && m[2] !== String(mes).padStart(2, '0')) return false;
  return true;
}

function coletarDocumentos({ companyDir, cnpj, ano, mes }) {
  const cnpjEmp = String(cnpj || '').replace(/\D/g, '');
  const res = { notas: [], itens: [], duplicatas: [], pagamentos: [], ctes: [], nfses: [] };
  const vistos = new Set();

  for (const arquivo of listarXmls(companyDir)) {
    const nome = path.basename(arquivo).toUpperCase();
    if (nome.includes('EVENTO')) continue;
    let xml;
    try { xml = fs.readFileSync(arquivo, 'utf8'); } catch (_) { continue; }
    if (/<(procEventoNFe|procEventoCTe|eventoCTe|evento)[\s>]/.test(xml) && !/<infNFe|<infCte|<infNFSe/.test(xml)) continue;
    const cancelada = /CANCELAD/i.test(path.relative(companyDir, arquivo));
    const rel = path.relative(companyDir, arquivo);

    try {
      // CT-e primeiro: ele também contém <infNFe> (chaves das NF-e transportadas)
      if (/<infCte[\s>]/.test(xml)) {
        const r = extrairCTe(xml, rel, cnpjEmp, cancelada);
        if (!r || !noPeriodo(r.data, ano, mes) || vistos.has(r.cte.chave)) continue;
        vistos.add(r.cte.chave);
        res.ctes.push(r.cte);
      } else if (/<infNFe[\s>]/.test(xml)) {
        const r = extrairNFe(xml, rel, cnpjEmp, cancelada);
        if (!r || !noPeriodo(r.data, ano, mes) || vistos.has(r.nota.chave)) continue;
        vistos.add(r.nota.chave);
        res.notas.push(r.nota); res.itens.push(...r.itens); res.duplicatas.push(...r.duplicatas); res.pagamentos.push(...r.pagamentos);
      } else {
        const r = extrairNFSe(xml, rel, cnpjEmp);
        if (!r || !noPeriodo(r.data, ano, mes)) continue;
        const id = r.nfse.chave || `${r.nfse.prestadorCnpj}-${r.nfse.numero}`;
        if (vistos.has(id)) continue;
        vistos.add(id);
        res.nfses.push(r.nfse);
      }
    } catch (err) {
      console.warn(`[Relatório Excel] Falha ao ler ${rel}:`, err.message);
    }
  }

  const porData = (campo) => (a, b) => (b[campo] ? b[campo].getTime() : 0) - (a[campo] ? a[campo].getTime() : 0);
  res.notas.sort(porData('dhEmi'));
  res.itens.sort((a, b) => porData('dhEmi')(a, b) || (a.nItem || 0) - (b.nItem || 0));
  res.duplicatas.sort(porData('dhEmi'));
  res.pagamentos.sort(porData('dhEmi'));
  res.ctes.sort(porData('dhEmi'));
  res.nfses.sort(porData('dataEmissao'));
  return res;
}

// ------------------------------------------------------------------
// Escrita da planilha
// ------------------------------------------------------------------
const COR_CABECALHO = 'FF003366';
const COR_TOTAL = 'FFE8EEF6';

function escreverAba(wb, nome, cols, linhas, corAba) {
  const ws = wb.addWorksheet(nome, {
    properties: { tabColor: { argb: corAba } },
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }]
  });
  ws.columns = cols.map((c) => ({
    header: c.header, key: c.key,
    width: c.width || (c.tipo === 'm' ? 14 : c.tipo === 'p' ? 9 : c.tipo === 'q' ? 13 : 16),
    style: FORMATOS[c.tipo] ? { numFmt: FORMATOS[c.tipo] } : {}
  }));

  const header = ws.getRow(1);
  header.height = 32;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_CABECALHO } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  for (const l of linhas) {
    const valores = {};
    for (const c of cols) {
      const v = l[c.key];
      valores[c.key] = v === undefined || v === '' ? null : v;
    }
    ws.addRow(valores);
  }

  // Linha de totais com SUBTOTAL (respeita os filtros aplicados no Excel)
  if (linhas.length > 0) {
    const ultima = linhas.length + 1;
    const total = ws.addRow({});
    total.getCell(1).value = `TOTAL (${linhas.length} registro${linhas.length > 1 ? 's' : ''})`;
    cols.forEach((c, i) => {
      if (c.tipo === 'm') {
        const letra = ws.getColumn(i + 1).letter;
        total.getCell(i + 1).value = { formula: `SUBTOTAL(9,${letra}2:${letra}${ultima})` };
      }
    });
    total.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_TOTAL } };
      cell.border = { top: { style: 'thin', color: { argb: 'FF003366' } } };
    });
  }
  return ws;
}

const soma = (lista, campo, filtro = () => true) => lista.filter(filtro).reduce((s, x) => s + (Number(x[campo]) || 0), 0);

function escreverResumo(wb, { razaoSocial, cnpj, ano, mes, dados }) {
  const ws = wb.addWorksheet('Resumo', { properties: { tabColor: { argb: COR_CABECALHO } } });
  ws.columns = [{ width: 42 }, { width: 14 }, { width: 18 }, { width: 18 }];
  const periodo = ano === 'todos' || !ano ? 'Todos os períodos' : mes === 'todos' || !mes ? `Ano ${ano}` : `${String(mes).padStart(2, '0')}/${ano}`;

  const titulo = ws.addRow(['Relatório Fiscal Completo']);
  titulo.font = { bold: true, size: 16, color: { argb: COR_CABECALHO } };
  ws.addRow(['Empresa', razaoSocial || '']);
  ws.addRow(['CNPJ', fmtCnpj(cnpj)]);
  ws.addRow(['Período', periodo]);
  ws.addRow(['Gerado em', new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })]);
  for (let r = 2; r <= 5; r++) ws.getRow(r).getCell(1).font = { bold: true };
  ws.addRow([]);

  const secao = (texto, cabecalhos) => {
    const r = ws.addRow([texto, ...cabecalhos]);
    r.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR_CABECALHO } };
    });
  };

  const { notas, itens, ctes, nfses } = dados;
  const validas = (x) => x.situacao !== 'Cancelada';
  secao('Documentos', ['Quantidade', 'Canceladas', 'Valor Total (R$)']);
  const grupos = [
    ['NF-e de entrada (recebidas)', notas.filter((x) => x.modelo === 'NF-e 55' && x.operacao.startsWith('Entrada')), 'vNF'],
    ['NF-e de saída (emitidas)', notas.filter((x) => x.modelo === 'NF-e 55' && x.operacao.startsWith('Saída')), 'vNF'],
    ['NF-e de terceiros', notas.filter((x) => x.modelo === 'NF-e 55' && x.operacao === 'Terceiros'), 'vNF'],
    ['NFC-e (cupons)', notas.filter((x) => x.modelo === 'NFC-e 65'), 'vNF'],
    ['CT-e (fretes)', ctes, 'vTPrest'],
    ['NFS-e tomadas', nfses.filter((x) => x.tipo === 'Tomada'), 'valorServicos'],
    ['NFS-e prestadas', nfses.filter((x) => x.tipo === 'Prestada'), 'valorServicos']
  ];
  for (const [rotulo, lista, campo] of grupos) {
    ws.addRow([rotulo, lista.length, lista.length - lista.filter(validas).length, soma(lista, campo, validas)]).getCell(4).numFmt = '#,##0.00';
  }
  ws.addRow(['Itens de produtos (NF-e/NFC-e)', itens.length]);
  ws.addRow([]);

  secao('Tributos (documentos não cancelados)', ['', '', 'Valor (R$)']);
  const nv = notas.filter(validas), cv = ctes.filter(validas), sv = nfses.filter(validas);
  const tributos = [
    ['ICMS (NF-e/NFC-e)', soma(nv, 'vICMS')], ['ICMS ST', soma(nv, 'vST')], ['FCP + FCP ST', soma(nv, 'vFCP') + soma(nv, 'vFCPST')],
    ['DIFAL (ICMS UF destino)', soma(nv, 'vICMSUFDest')], ['IPI', soma(nv, 'vIPI')], ['PIS (NF-e)', soma(nv, 'vPIS')], ['COFINS (NF-e)', soma(nv, 'vCOFINS')],
    ['ICMS (CT-e)', soma(cv, 'vICMS')], ['ISSQN (NFS-e)', soma(sv, 'valorISSQN')],
    ['Retenções NFS-e (IRRF + CSLL + INSS + PIS + COFINS)', soma(sv, 'irrf') + soma(sv, 'csll') + soma(sv, 'inss') + soma(sv, 'debitoPIS') + soma(sv, 'debitoCOFINS')],
    ['IBS (todos os documentos)', soma(nv, 'vIBS') + soma(cv, 'vIBS') + soma(sv, 'valorIBSTotal')],
    ['CBS (todos os documentos)', soma(nv, 'vCBS') + soma(cv, 'vCBS') + soma(sv, 'valorCBSTotal')]
  ];
  for (const [rotulo, valor] of tributos) {
    const r = ws.addRow([rotulo, null, null, valor]);
    r.getCell(4).numFmt = '#,##0.00';
  }
  ws.getColumn(4).numFmt = '#,##0.00';
  return ws;
}

async function gerarRelatorioExcel({ companyDir, cnpj, razaoSocial, ano, mes, filePath }) {
  const dados = coletarDocumentos({ companyDir, cnpj, ano, mes });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Captador de Notas Fiscais';
  wb.created = new Date();

  escreverResumo(wb, { razaoSocial, cnpj, ano, mes, dados });
  escreverAba(wb, 'NF-e e NFC-e', COLS_NOTAS, dados.notas, 'FF2563EB');
  escreverAba(wb, 'Itens (Produtos)', COLS_ITENS, dados.itens, 'FF0891B2');
  escreverAba(wb, 'Duplicatas', COLS_DUP, dados.duplicatas, 'FF7C3AED');
  escreverAba(wb, 'Pagamentos', COLS_PAG, dados.pagamentos, 'FF9333EA');
  escreverAba(wb, 'CT-e (Fretes)', COLS_CTE, dados.ctes, 'FFEA580C');
  escreverAba(wb, 'NFS-e (Serviços)', COLS_NFSE, dados.nfses, 'FF16A34A');

  await wb.xlsx.writeFile(filePath);

  return {
    totalNotas: dados.notas.length,
    totalItens: dados.itens.length,
    totalCtes: dados.ctes.length,
    totalNfses: dados.nfses.length
  };
}

module.exports = { gerarRelatorioExcel, coletarDocumentos };
