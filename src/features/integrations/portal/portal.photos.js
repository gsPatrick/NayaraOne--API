'use strict';

const { fetchExternalUrl } = require('../http/ssrfGuard');

/**
 * Foto de anúncio enviada por URL do portal (M9-D232, herdado da M9-D245): a ÚNICA forma de baixá-la é `fetchExternalUrl` com o fluxo `portal_photo` (só https, hosts
 * do CDN do portal em `integration.ssrf.fetch_allowlist`, tipo de imagem conferido, tamanho e tempo cortados, conteúdo para a quarentena). Nenhum outro caminho busca URL de portal.
 */
function fetchPortalPhoto(tenant, url, { transaction, connection } = {}) {
  return fetchExternalUrl(url, { flow: 'portal_photo', tenant, transaction, connection });
}

module.exports = { fetchPortalPhoto };
