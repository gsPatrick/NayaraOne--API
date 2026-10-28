'use strict';

const { SOURCE_TYPES } = require('./calendar.constants');

/**
 * Tipos de origem que o usuário pode ver: o mapa traz, por fonte, uma ou mais permissões do módulo de origem (qualquer uma
 * basta). Fonte sem mapeamento fica fechada (falha fechada). `permissions` são as do token da pessoa.
 */
function allowedSourceTypes(permissions, permissionMap) {
  const has = new Set(permissions || []);
  return SOURCE_TYPES.filter((source) => (permissionMap[source] || []).some((code) => has.has(code)));
}

module.exports = { allowedSourceTypes };
