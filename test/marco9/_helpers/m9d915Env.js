'use strict';

// Apoio dos testes M9-D915 (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). O registro de classificação é ajustado por commit real
// (PUT do steward) e cada teste devolve a coluna ao que era (`withColumn`).
const base = require('./m9d910Env');
const fieldAccess = require('../../../src/features/core-governance/data-quality/fieldAccess.service');
const aiAccess = require('../../../src/features/core-governance/data-quality/aiAccess.guard');
const fieldMask = require('../../../src/features/core-governance/data-quality/fieldAccess.mask');

const VIEW_RESTRICTED = 'governance:dlp:view-restricted';
const CPF = '12345678934';
const CPF_FORMATTED = '123.456.789-34';

/** O ator do serviço: empresa, usuário e permissões. */
const actorOf = (tenant, permissions = []) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId, permissions });
const COL = { schema: 'people', table: 'persons' };

/** Ajusta UMA coluna do registro de `tenant` durante `fn` e a devolve ao que era (mesmos atributos, com commit). */
async function withColumn(tenant, column, changes, fn, where = COL) {
  const before = await base.rowOf(tenant, where.schema, where.table, column);
  const back = { classification: before.classification, purpose: before.purpose, masking: before.masking, mask_pattern: before.mask_pattern, exportability: before.exportability, ai_allowed: before.ai_allowed };
  await base.put(tenant, { ...where, column, ...changes });
  try { return await fn(); } finally { await base.put(tenant, { ...where, column, ...back }); }
}

const auditRows = async (tenant, action) => (await base.adminQuery('SELECT * FROM audit.audit_log WHERE company_id = $1 AND action = $2 ORDER BY occurred_at DESC', [tenant.companyId, action])).rows;
const refused = (promise) => promise.then(() => null, (err) => ({ status: err.statusCode, code: err.code, message: err.message, details: err.details }));

module.exports = { ...base, fieldAccess, aiAccess, fieldMask, actorOf, withColumn, auditRows, refused, VIEW_RESTRICTED, CPF, CPF_FORMATTED, COL };
