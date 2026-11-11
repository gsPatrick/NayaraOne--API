'use strict';

// Pedido de exportação de oportunidades ao guard do DLP, exatamente como o POST /exports monta (export.request.js), com as permissões
// e o MFA informados pelo teste (o guard aceita `permissions`; sem elas, leria as do banco). Usado pelos testes de serviço do M3-21.
const crypto = require('node:crypto');
const guardService = require('../../src/features/core-governance/dlp/guard.service');
const { blockedError } = require('../../src/features/core-governance/dlp/guard.reasons');
const { getEntry } = require('../../src/features/core-governance/dlp/exports/exports.catalog');

const ENTRY = getEntry('crm.opportunities');
const JUSTIFICATION = 'Relatório da reunião semanal de vendas da equipe comercial';

/** Decisão do guard para exportar `estimatedRows` oportunidades. Devolve { decision, error } (error = o AppError que a rota lançaria). */
async function decideExport(tenant, { permissions, mfaOk, estimatedRows = 1, actorUserId = tenant.userId, maxRowsCap = null }) {
  const decision = await guardService.decide({ groupId: tenant.groupId, companyId: tenant.companyId, userId: actorUserId }, {
    action: 'EXPORT', kind: 'EXPORT', resourceType: ENTRY.code, minClassification: ENTRY.minClassification, originPermission: ENTRY.permission,
    query: { filter: {}, columns: ENTRY.columns.map((c) => c.key), format: 'CSV' }, purpose: 'OPERACAO', justification: JUSTIFICATION, estimatedRows,
    mfaOk, permissions, idempotencyKey: `m3-export-${crypto.randomUUID()}`, actorUserId, maxRowsCap,
  });
  return { decision, error: decision.decision === 'DENY' ? blockedError(decision, decision.justificationMin) : null };
}

module.exports = { decideExport, ENTRY };
