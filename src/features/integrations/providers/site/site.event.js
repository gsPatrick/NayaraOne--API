'use strict';

/**
 * Evento interno normalizado do site (M9-D259 3.1 `toInternalEvent`): todo adapter de site devolve o MESMO formato, qualquer que seja o webhook do site. `resourceRef` é o identificador
 * da OPERAÇÃO no site (o mesmo do envio), por isso a ordem dos status vale só dentro do mesmo envio; `data` leva só identificadores (nunca conteúdo da página).
 */
const texto = (v, max = 160) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : null));

function siteEvent({ pageKey, publicationId, externalStatus, occurredAt = null, reason = null }) {
  return {
    eventType: 'integration.site.page.status',
    resourceRef: texto(publicationId),
    externalStatus: texto(externalStatus, 40),
    idempotencyKey: null,
    data: { pageKey: texto(pageKey), occurredAt: texto(occurredAt, 40) },
    private: { reason: texto(reason, 300) },
  };
}

module.exports = { siteEvent };
