'use strict';

const { SandboxAntivirusAdapter } = require('./AntivirusAdapter');
const { SandboxOcrAdapter } = require('./OcrAdapter');
const { ClamAvAdapter } = require('./ClamAvAdapter');
const { LocalOcrAdapter } = require('./LocalOcrAdapter');

// resolveAntivirusAdapter / resolveOcrAdapter — mesmo padrão de resolveBankAdapter.js/
// resolveInsuranceAdapter.js. O motor real só entra quando a infraestrutura é ativada por
// variável de ambiente (ANTIVIRUS_PROVIDER=clamav, OCR_PROVIDER=local); sem ela, o adaptador de
// laboratório continua sendo o padrão seguro. A ativação em servidor depende de aprovação da
// Contratante (custo de infraestrutura).
// eslint-disable-next-line no-unused-vars
async function resolveAntivirusAdapter(tenant, transaction) {
  if (String(process.env.ANTIVIRUS_PROVIDER || '').toLowerCase() === 'clamav') {
    return new ClamAvAdapter();
  }
  return new SandboxAntivirusAdapter();
}

// eslint-disable-next-line no-unused-vars
async function resolveOcrAdapter(tenant, transaction) {
  if (String(process.env.OCR_PROVIDER || '').toLowerCase() === 'local') {
    return new LocalOcrAdapter();
  }
  return new SandboxOcrAdapter();
}

module.exports = { resolveAntivirusAdapter, resolveOcrAdapter };
