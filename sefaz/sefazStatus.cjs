// Tradução das respostas (cStat) da SEFAZ nas consultas de distribuição (NF-e e CT-e)
// em mensagens claras com a orientação de como resolver.

const DICAS = {
  '108': 'Serviço da SEFAZ paralisado momentaneamente. Tente novamente em alguns minutos.',
  '109': 'Serviço da SEFAZ paralisado sem previsão de retorno. Tente novamente mais tarde.',
  '214': 'Mensagem enviada maior que o permitido pela SEFAZ.',
  '215': 'Falha no schema XML da consulta. Reinicie o NSU da empresa e tente novamente.',
  '225': 'Falha no schema XML da consulta. Reinicie o NSU da empresa e tente novamente.',
  '236': 'Chave de acesso com dígito verificador inválido.',
  '238': 'Versão do leiaute não suportada pela SEFAZ.',
  '239': 'Versão do leiaute não suportada pela SEFAZ.',
  '252': 'Ambiente informado diverge do ambiente da SEFAZ. Confira se a empresa está em Produção (ambiente 1) no cadastro.',
  '280': 'Certificado digital inválido. Envie novamente o arquivo .pfx correto da empresa.',
  '281': 'Certificado digital fora da validade (vencido ou ainda não válido). Renove o certificado A1.',
  '282': 'Certificado digital sem CNPJ. Use o e-CNPJ da empresa (o e-CPF não serve para consultar notas).',
  '283': 'Cadeia do certificado digital com erro. Reexporte o .pfx incluindo a cadeia completa.',
  '284': 'Certificado digital revogado. Emita um novo certificado A1.',
  '285': 'Certificado não é ICP-Brasil. Use um certificado A1 emitido por autoridade certificadora ICP-Brasil.',
  '286': 'Não foi possível verificar a revogação do certificado (LCR indisponível). Tente novamente mais tarde.',
  '289': 'Código da UF informada diverge da UF da empresa. Confira a UF no cadastro da empresa.',
  '402': 'O XML da consulta contém caracteres inválidos.',
  '404': 'Uso de prefixo de namespace não permitido.',
  '472': 'CNPJ/CPF da consulta é inválido. Confira o CNPJ no cadastro da empresa.',
  '489': 'CNPJ informado é inválido. Confira o CNPJ no cadastro da empresa.',
  '593': 'O certificado digital pertence a outra empresa (CNPJ base diferente). Envie o certificado A1 desta empresa ou da sua matriz.',
  '632': 'A nota tem mais de 90 dias e já não está disponível na distribuição da SEFAZ.',
  '640': 'A empresa não tem permissão para consultar esta chave de acesso.',
  '641': 'A nota consultada não pertence a esta empresa (emitente, destinatário ou transportador).',
  '653': 'A NF-e está cancelada e o arquivo não está mais disponível.',
  '654': 'A NF-e foi denegada e o arquivo não está disponível.',
  '656': 'Consumo indevido: a SEFAZ bloqueou novas consultas por 1 hora. Aguarde antes de sincronizar de novo.',
  '999': 'Erro não catalogado na SEFAZ. Tente novamente em alguns minutos.'
};

function explicarCStat(cStat, xMotivo) {
  const base = `SEFAZ: ${cStat}${xMotivo ? ` - ${xMotivo}` : ''}`;
  const dica = DICAS[String(cStat)];
  return dica ? `${base}. ${dica}` : base;
}

// Confere se o CNPJ base (8 primeiros dígitos) do certificado é o mesmo da empresa,
// pois a SEFAZ só entrega documentos de CNPJs com a mesma raiz do certificado (rejeição 593).
function validarCertificadoDaEmpresa(certInfo, cnpjEmpresa) {
  const cnpjCert = String((certInfo && certInfo.extractedCnpj) || '').replace(/\D/g, '');
  const cnpj = String(cnpjEmpresa || '').replace(/\D/g, '');
  if (cnpjCert.length === 14 && cnpj.length === 14 && cnpjCert.slice(0, 8) !== cnpj.slice(0, 8)) {
    throw new Error(
      `O certificado digital é do CNPJ ${cnpjCert.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}, ` +
      'que não pertence a esta empresa. Envie o certificado A1 desta empresa (ou da matriz, com a mesma raiz de CNPJ).'
    );
  }
}

module.exports = { explicarCStat, validarCertificadoDaEmpresa };
