'use strict';

const crypto = require('node:crypto');
const { IntegrationConnection } = require('../../../../models');
const adapterRegistry = require('../../../../features/integrations/registry/adapterRegistry');
const { applySignatureEvent, findEnvelope } = require('./signature.events');

/**
 * Rota antiga do Clicksign (`POST /v1/legal/webhooks/clicksign`, alias do mesmo framework, M9-D211/D236): depois da assinatura HMAC conferida pelo controlador (agora com o segredo do
 * cofre), o evento do Clicksign vira o evento interno normalizado do adapter e segue o MESMO caminho do webhook da rota única (envelope, signatário previsto, evidência, hash,
 * portão do contrato). Devolve a resposta da rota antiga, ou null quando o evento não pertence a um envelope registrado (assinatura anterior ao registro: segue o caminho antigo).
 */
async function applyClicksignEvent(ctx, body, rawBody, transaction) {
  const adapter = adapterRegistry.instantiate('signature-clicksign');
  const ev = adapter.toInternalEvent(body);
  if (!ev.data || !ev.data.kind) return null;
  const connection = await IntegrationConnection.findOne({ where: { companyId: ctx.companyId, providerCode: 'signature-clicksign' }, order: [['created_at', 'ASC']], transaction });
  const row = {
    id: null, legacyAlias: true, providerCode: 'signature-clicksign', connectionId: connection ? connection.id : null,
    externalEventId: crypto.createHash('sha256').update(rawBody || JSON.stringify(body)).digest('hex'),
  };
  const envelope = await findEnvelope(ctx, row, ev.data, transaction);
  if (!envelope) return null;
  const r = await applySignatureEvent(ctx, row, ev, transaction);
  return { acknowledged: true, processed: r.applied !== false, via: 'envelope', envelopeId: envelope.id };
}

module.exports = { applyClicksignEvent };
