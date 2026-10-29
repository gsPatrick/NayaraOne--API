'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { rawBodyMiddleware } = require('./webhooks.rawBody');
const { checkWebhookRate } = require('./webhooks.rateLimit');

/**
 * Aliases das rotas públicas dos fornecedores já configurados (M9-D211 5): o mesmo caminho e o mesmo contrato de resposta, agora sobre o framework —
 * corpo bruto com o mesmo limite, o limite WEBHOOK compartilhado da M9-D843 (por IP e fornecedor, antes de qualquer consulta) e o controlador de cada módulo.
 * Esses fornecedores trazem a identificação do caso no corpo (o tenant sai da tabela de roteamento do módulo, até a migração do canal), então o módulo lê o
 * JSON; o framework não rejeita JSON inválido: o módulo recebe corpo vazio e responde como a um evento sem identificação, sem efeito (cada módulo mantém o seu contrato).
 */
function tolerantJson(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return {};
  try {
    const v = JSON.parse(raw.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Cadeia de middlewares do alias: `provider` é o nome fixo do fornecedor ou uma função do pedido. */
function legacyAlias(provider, controller) {
  const gate = catchAsync(async (req, res, next) => {
    await checkWebhookRate(req, typeof provider === 'function' ? provider(req) : provider, res);
    req.body = tolerantJson(req.rawBody);
    next();
  });
  return [rawBodyMiddleware, gate, controller];
}

module.exports = { legacyAlias, tolerantJson };
