const https = require('https');
const crypto = require('crypto');
const axios = require('axios');

class SoapClient {
  constructor(certPem, keyPem, caPems = []) {
    this.certPem = certPem;
    this.keyPem = keyPem;
    this.caPems = caPems;

    const agentOptions = {
      cert: this.certPem,
      key: this.keyPem,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    };

    if (this.caPems && this.caPems.length > 0) {
      agentOptions.ca = this.caPems;
    }

    if (crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT) {
      agentOptions.secureOptions = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT;
    }

    this.httpsAgent = new https.Agent(agentOptions);
  }

  async send(url, soapAction, bodyXml, timeoutMs = 60000) {
    const headers = {
      'Content-Type': `application/soap+xml; charset=utf-8; action="${soapAction}"`,
      'Accept': 'application/soap+xml, text/xml, */*'
    };

    // Falhas de rede passageiras ou indisponibilidade momentânea da SEFAZ: tenta de novo antes de desistir
    const TENTATIVAS = 3;
    for (let tentativa = 1; ; tentativa++) {
      try {
        const response = await axios.post(url, bodyXml, {
          headers,
          httpsAgent: this.httpsAgent,
          timeout: timeoutMs,
          responseType: 'text'
        });
        return response.data;
      } catch (err) {
        const status = err.response && err.response.status;
        const transitorio = status
          ? [502, 503, 504].includes(status)
          : /ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up|timeout/i.test(`${err.code || ''} ${err.message || ''}`);

        if (transitorio && tentativa < TENTATIVAS) {
          await new Promise((r) => setTimeout(r, tentativa * 3000));
          continue;
        }

        if (err.response) {
          const corpo = String(err.response.data || '');
          const fault = corpo.match(/<(?:\w+:)?(?:Text|faultstring)[^>]*>([^<]+)</i);
          throw new Error(`Erro na resposta da SEFAZ (HTTP ${status})${fault ? `: ${fault[1].trim()}` : ''}. Tente novamente em alguns minutos.`);
        }
        if (/ECONNABORTED|timeout/i.test(`${err.code || ''} ${err.message || ''}`)) {
          throw new Error(`A SEFAZ não respondeu a tempo após ${TENTATIVAS} tentativas (${url}). O serviço pode estar instável; tente novamente em alguns minutos.`);
        }
        if (/certificate|ssl|tls|handshake|alert/i.test(err.message || '')) {
          throw new Error(`A SEFAZ recusou a conexão com o certificado digital: ${err.message}. Confira se o certificado A1 é válido, ICP-Brasil e não está revogado.`);
        }
        throw new Error(`Falha de comunicação com a SEFAZ após ${TENTATIVAS} tentativas: ${err.message}`);
      }
    }
  }
}

module.exports = SoapClient;
