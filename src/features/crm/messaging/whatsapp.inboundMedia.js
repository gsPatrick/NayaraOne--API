'use strict';

const { sequelize } = require('../../../models');
const { fetchExternalUrl } = require('../../integrations/http/ssrfGuard');

const FLOW = 'message_media';
let buscador = null;

/** Só para teste: troca o buscador (servidor HTTPS local, DNS simulado). Em produção a mídia é buscada sempre por `fetchExternalUrl`. */
function _usarBuscador(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Troca de buscador só em teste.');
  buscador = fn;
}

/**
 * Mídia que chega (M9-D230 3.3): a URL do fornecedor é buscada SÓ pelo guarda SSRF com o fluxo `message_media` (https, hosts do fornecedor em `integration.ssrf.fetch_allowlist`, tipo e tamanho
 * conferidos) e o conteúdo entra na QUARENTENA (M9-D247) antes de qualquer uso. Roda num savepoint: a recusa do guarda nunca derruba o registro da mensagem. Devolve { quarantineId } ou
 * { blocked: true, code } quando não foi possível baixar com segurança (o chamador marca a mídia como bloqueada).
 */
async function receiveInboundMedia(ctx, { url, connection }, transaction) {
  const buscar = buscador || ((u, opts) => fetchExternalUrl(u, { ...opts, flow: FLOW }));
  try {
    const r = await sequelize.transaction({ transaction }, (savepoint) => buscar(String(url), { tenant: ctx, transaction: savepoint, connection, flow: FLOW }));
    return { quarantineId: r.quarantine && r.quarantine.ref ? r.quarantine.ref.quarantineId : null };
  } catch (err) {
    return { blocked: true, code: err.code || 'INTEGRATION_MESSAGING_MEDIA_FETCH_FAILED' };
  }
}

module.exports = { receiveInboundMedia, _usarBuscador, FLOW };
