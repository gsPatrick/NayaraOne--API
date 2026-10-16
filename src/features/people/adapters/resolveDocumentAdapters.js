'use strict';

const { SandboxAntivirusAdapter } = require('./AntivirusAdapter');
const { SandboxOcrAdapter } = require('./OcrAdapter');

// resolveAntivirusAdapter / resolveOcrAdapter — mesmo padrão de resolveBankAdapter.js/
// resolveInsuranceAdapter.js (fallback seguro para Sandbox). Nenhum provedor real de
// antivírus/OCR foi contratado ainda — a função existe para que, quando houver um, baste
// adicionar o branch de credenciais aqui (exatamente como resolveInsuranceAdapter.js faz para
// Porto Seguro/Yelum), sem precisar tocar em documentIngestion.service.js.
// eslint-disable-next-line no-unused-vars
async function resolveAntivirusAdapter(tenant, transaction) {
  return new SandboxAntivirusAdapter();
}

// eslint-disable-next-line no-unused-vars
async function resolveOcrAdapter(tenant, transaction) {
  return new SandboxOcrAdapter();
}

module.exports = { resolveAntivirusAdapter, resolveOcrAdapter };
