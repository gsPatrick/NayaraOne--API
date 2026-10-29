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

/**
 * Tipos de item (`source_kind`) que o usuário NÃO pode ver mesmo vendo a origem: a origem GUARANTEE mistura fiança de contrato
 * (jurídico) e garantia de obra (obras). O mapa traz, por tipo, as permissões aceitas (qualquer uma basta); tipo fora do mapa
 * segue só a regra da origem.
 */
function deniedSourceKinds(permissions, kindPermissionMap) {
  const has = new Set(permissions || []);
  return Object.entries(kindPermissionMap || {}).filter(([, codes]) => !codes.some((code) => has.has(code))).map(([kind]) => kind);
}

module.exports = { allowedSourceTypes, deniedSourceKinds };
