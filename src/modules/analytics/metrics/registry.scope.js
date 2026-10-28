'use strict';

/**
 * M9-D603/D604 — escopo e trava da definição de métrica, compartilhados pela publicação (v1), pela nova versão e pela edição
 * de texto. `ctx = { groupId, companyId, actorUserId, permissions }`.
 */
const { sequelize } = require('../../../models');

const ZERO = '00000000-0000-0000-0000-000000000000';

function resolveScope(input, ctx) {
  const scopeLevel = input.scopeLevel || 'GLOBAL';
  if (scopeLevel === 'GLOBAL') return { scopeLevel, groupId: null, companyId: null };
  if (scopeLevel === 'GROUP') return { scopeLevel, groupId: input.groupId || ctx.groupId, companyId: null };
  return { scopeLevel, groupId: input.groupId || ctx.groupId, companyId: input.companyId || ctx.companyId };
}

async function findDefinitionForUpdate(code, scope, transaction) {
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.metric_definitions WHERE metric_code = :code
        AND COALESCE(company_id, '${ZERO}'::uuid) = COALESCE(CAST(:companyId AS uuid), '${ZERO}'::uuid)
        AND COALESCE(group_id, '${ZERO}'::uuid) = COALESCE(CAST(:groupId AS uuid), '${ZERO}'::uuid)
      FOR UPDATE`,
    { replacements: { code, companyId: scope.companyId, groupId: scope.groupId }, transaction }
  );
  return rows[0] || null;
}

/**
 * Definição de um código visível ao contexto, travada (FOR UPDATE). Sem escopo informado, vale a mais específica:
 * empresa, depois grupo, depois catálogo global (a mesma ordem da leitura).
 */
async function findVisibleDefinitionForUpdate(code, scopeInput, ctx, transaction) {
  if (scopeInput && scopeInput.scopeLevel) return findDefinitionForUpdate(code, resolveScope(scopeInput, ctx), transaction);
  for (const scopeLevel of ['COMPANY', 'GROUP', 'GLOBAL']) {
    const def = await findDefinitionForUpdate(code, resolveScope({ scopeLevel }, ctx), transaction);
    if (def) return def;
  }
  return null;
}

module.exports = { resolveScope, findDefinitionForUpdate, findVisibleDefinitionForUpdate };
