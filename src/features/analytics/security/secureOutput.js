'use strict';

/**
 * M9-D700 (3.4, 3.5, 3.6) — ÚNICO caminho de saída de linhas de detalhe do BI (drill-down M9-D690, exportação M9-D701,
 * brief e ferramentas da NAY M9-D695): confere a permissão do BI e a do domínio, mascara RESTRICTED (sem desligar) e grava o
 * log de acesso com as linhas devolvidas. Quem devolver linha de read model sem passar aqui reprova a varredura de segurança.
 */
const { assertPermission } = require('./permissionGuard');
const { assertDomainAccess } = require('./abac');
const { maskRestricted, parseExtraFields } = require('./masking');
const { recordAccess } = require('./accessLog');
const { readParam, KEYS } = require('./securityParams');

/**
 * @param ctx { groupId, companyId, actorUserId, permissions }
 * @param options { permission (do catálogo), domain, action, resourceType, resourceCode, route, filters, rows, ip, transaction, rowsReturned? (quando as linhas não passam por aqui, como no pedido e no download do arquivo de exportação) }
 * @returns { rows, maskedCount }
 */
async function prepareSecureRows(ctx, options) {
  const { permission, domain, action, resourceType, resourceCode, route, filters, rows, ip, transaction } = options;
  const counted = Number.isInteger(options.rowsReturned) && options.rowsReturned >= 0 ? options.rowsReturned : null; // exportação: o arquivo tem as linhas, o log conta quantas
  assertPermission(ctx, permission);
  if (domain) await assertDomainAccess(ctx, domain, transaction);
  const extra = parseExtraFields(await readParam(KEYS.EXTRA_MASKED_FIELDS, ctx, transaction));
  const { data, maskedCount } = maskRestricted(rows, extra);
  await recordAccess(ctx, {
    action, resourceType, resourceCode, route, filters, ip, rowsReturned: counted !== null ? counted : (Array.isArray(data) ? data.length : 1), maskingApplied: maskedCount > 0,
  });
  return { rows: data, maskedCount };
}

module.exports = { prepareSecureRows };
