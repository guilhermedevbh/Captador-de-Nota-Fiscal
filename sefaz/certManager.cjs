const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const forge = require('node-forge');
const { resolverCertificado, MSG_CERT_AUSENTE } = require('./certResolver.cjs');
const { decryptPassword } = require('../nfse/cryptoUtils.cjs');

function traduzirErroCertificado(err) {
  const msg = String((err && err.message) || err);
  if (/MAC could not be verified|Invalid password|mac verify failure/i.test(msg)) {
    return 'Senha do certificado digital incorreta. Confira a senha no cadastro da empresa (Configurações → Empresas).';
  }
  if (/Too few bytes|Unparsed DER|ASN\.1|not a valid|Invalid DER/i.test(msg)) {
    return 'O arquivo enviado não é um certificado .pfx/.p12 válido (arquivo corrompido ou de outro tipo). Envie novamente o certificado A1 da empresa.';
  }
  if (/Unsupported OID|Cannot read encrypted/i.test(msg)) {
    return 'O certificado usa uma criptografia não suportada. Reexporte o .pfx marcando "TripleDES-SHA1" (ou envie o arquivo original da certificadora).';
  }
  if (/não localizad|não encontrado|vazio/i.test(msg)) return msg;
  return `Não foi possível ler o certificado digital: ${msg}`;
}

class CertManager {
  constructor(certPath, password) {
    this.certPath = certPath;
    this.password = decryptPassword(password || '');
    this.pfxBuffer = null;
    this.certPem = null;
    this.keyPem = null;
    this.certRawBase64 = null;
    this.fullCertChainPem = null;
    this.caPems = [];
    this.info = null;
  }

  load() {
    const resolvido = resolverCertificado(this.certPath);
    if (!resolvido) {
      throw new Error(`Arquivo de certificado não encontrado em: ${this.certPath}. ${MSG_CERT_AUSENTE}`);
    }
    this.certPath = resolvido;

    this.pfxBuffer = fs.readFileSync(this.certPath);
    if (!this.pfxBuffer.length) {
      throw new Error('O arquivo do certificado digital está vazio. Envie novamente o .pfx da empresa.');
    }

    try {
      const { key, allCerts } = this.extrairChaveECertificados();

      if (allCerts.length === 0) {
        throw new Error('Certificado X.509 não localizado dentro do arquivo .pfx.');
      }
      if (!key) {
        throw new Error('Chave privada não localizada dentro do arquivo .pfx.');
      }

      let clientCert = null;
      const caCerts = [];

      for (const cert of allCerts) {
        if (cert.publicKey && key.n && cert.publicKey.n && cert.publicKey.n.equals(key.n)) {
          clientCert = cert;
        } else {
          caCerts.push(cert);
        }
      }

      if (!clientCert) {
        clientCert = allCerts[0];
      }

      this.certPem = forge.pki.certificateToPem(clientCert);
      this.caPems = caCerts.map(c => forge.pki.certificateToPem(c));
      this.fullCertChainPem = [this.certPem, ...this.caPems].join('\n');
      this.keyPem = forge.pki.privateKeyToPem(key);

      this.certRawBase64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(clientCert)).getBytes());

      const cert = clientCert;
      const subjectAttrs = cert.subject.attributes.reduce((acc, attr) => {
        acc[attr.shortName || attr.name] = attr.value;
        return acc;
      }, {});

      const issuerAttrs = cert.issuer.attributes.reduce((acc, attr) => {
        acc[attr.shortName || attr.name] = attr.value;
        return acc;
      }, {});

      const validFrom = cert.validity.notBefore;
      const validTo = cert.validity.notAfter;
      const now = new Date();
      const isExpired = now > validTo;
      const daysRemaining = Math.ceil((validTo - now) / (1000 * 60 * 60 * 24));

      // Extrair CNPJ se presente no CommonName (ex: EMPRESA:12345678000199)
      const cn = subjectAttrs.CN || '';
      let cnpjMatch = cn.match(/(\d{14})/);
      const extractedCnpj = cnpjMatch ? cnpjMatch[1] : '';

      this.info = {
        subject: cn || 'Desconhecido',
        issuer: issuerAttrs.CN || 'Desconhecido',
        extractedCnpj,
        validFrom,
        validTo,
        isExpired,
        daysRemaining
      };

      return this.info;
    } catch (err) {
      throw new Error(traduzirErroCertificado(err));
    }
  }

  // Lê chave privada e certificados do .pfx com node-forge; se o arquivo usar criptografia
  // que o forge não suporta (ex.: AES-256 dos PFX exportados por Windows/OpenSSL 3), usa o OpenSSL.
  extrairChaveECertificados() {
    try {
      const p12Asn1 = forge.asn1.fromDer(this.pfxBuffer.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, this.password);
      let key = null;
      const allCerts = [];
      for (const sc of (p12.safeContents || [])) {
        for (const safeBag of (sc.safeBags || [])) {
          if (safeBag.key) key = safeBag.key;
          if (safeBag.cert) allCerts.push(safeBag.cert);
        }
      }
      return { key, allCerts };
    } catch (errForge) {
      if (/MAC could not be verified|Invalid password/i.test(errForge.message)) throw errForge;
      const viaOpenssl = this.extrairViaOpenssl();
      if (viaOpenssl) return viaOpenssl;
      throw errForge;
    }
  }

  extrairViaOpenssl() {
    const tmp = path.join(os.tmpdir(), `cert-${process.pid}-${Date.now()}.pfx`);
    let senhaErrada = false;
    try {
      fs.writeFileSync(tmp, this.pfxBuffer, { mode: 0o600 });
      for (const extra of [[], ['-legacy']]) {
        try {
          const pem = execFileSync('openssl', ['pkcs12', '-in', tmp, '-nodes', '-passin', 'env:CAPTADOR_PFX_PASS', ...extra], {
            env: { ...process.env, CAPTADOR_PFX_PASS: this.password || '' },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 15000
          }).toString();
          const blocoChave = pem.match(/-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |ENCRYPTED )?PRIVATE KEY-----/);
          const blocosCert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
          if (!blocoChave || blocosCert.length === 0) continue;
          return {
            key: forge.pki.privateKeyFromPem(blocoChave[0]),
            allCerts: blocosCert.map((c) => forge.pki.certificateFromPem(c))
          };
        } catch (errOpenssl) {
          if (/mac verify|invalid password|bad decrypt/i.test(String(errOpenssl.stderr || ''))) senhaErrada = true;
        }
      }
    } catch (_) {
      // OpenSSL indisponível: mantém o erro original do forge
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    }
    if (senhaErrada) throw new Error('MAC could not be verified. Invalid password?');
    return null;
  }

  getPfxBuffer() {
    return this.pfxBuffer;
  }

  getCertPem() {
    return this.certPem;
  }

  getKeyPem() {
    return this.keyPem;
  }

  getCertRawBase64() {
    return this.certRawBase64;
  }

  getFullCertChainPem() {
    return this.fullCertChainPem || this.certPem;
  }

  getCaPems() {
    return this.caPems || [];
  }

  getInfo() {
    return this.info;
  }
}

module.exports = CertManager;
