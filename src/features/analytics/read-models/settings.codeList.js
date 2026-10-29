'use strict';

/**
 * M9-D618 e M9-D619 — parâmetro do administrador que é uma lista de códigos (status, tipos) em maiúsculas separados por vírgula.
 * `codeList` valida para o SETTINGS_SCHEMA; `readCodeList` lê o valor da empresa e volta ao padrão se estiver ausente ou inválido.
 * Sem dependência no topo de settings.service nem de AppError (evita ciclo; as leituras usam import tardio).
 */
const CODE_LIST_RE = /^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$/;
const compact = (value) => String(value).replace(/\s+/g, '');

function codeList(key, value) {
  const AppError = require('../../../utils/AppError'); // import tardio: este arquivo é carregado pelo settings.service
  if (!CODE_LIST_RE.test(compact(value))) {
    throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de códigos em maiúsculas separados por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

async function readCodeList(key, defaultValue, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const raw = compact(await getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, defaultValue));
  return (CODE_LIST_RE.test(raw) ? raw : defaultValue).split(',');
}

module.exports = { CODE_LIST_RE, codeList, readCodeList };
