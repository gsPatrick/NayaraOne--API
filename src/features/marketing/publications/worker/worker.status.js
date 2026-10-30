'use strict';

/**
 * Status real do provedor (M9-D411 item 8). O que o canal devolve é guardado como veio em `provider_status`; aqui ele é lido em três classes: no ar (LIVE e os
 * equivalentes dos canais: PUBLISHED, SENT, DELIVERED), recusado (REJECTED, FAILED, ERROR) e em processamento (qualquer outro, por exemplo PROCESSING). "Publicado" só
 * quando no ar; o processamento é consultado de novo por getStatus, nunca presumido.
 */
const LIVE_STATUSES = Object.freeze(['LIVE', 'PUBLISHED', 'SENT', 'DELIVERED']);
const REJECTED_STATUSES = Object.freeze(['REJECTED', 'FAILED', 'ERROR']);

function statusKind(status) {
  const value = String(status || '').trim().toUpperCase();
  if (LIVE_STATUSES.includes(value)) return 'LIVE';
  if (REJECTED_STATUSES.includes(value)) return 'REJECTED';
  return 'PROCESSING';
}

const providerStatusOf = (status) => (String(status || '').trim().toUpperCase() || null);

module.exports = { statusKind, providerStatusOf, LIVE_STATUSES, REJECTED_STATUSES };
