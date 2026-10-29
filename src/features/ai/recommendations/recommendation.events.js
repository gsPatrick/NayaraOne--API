'use strict';

const { publishRecommendationEvent } = require('../events');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { auditSnapshot } = require('./recommendation.mapper');

/** Trilha antes/depois (campos de controle). O ator é a pessoa; a NAY (identidade de serviço) fica sem ator. */
async function auditRecommendation(ctx, action, rec, before, reason, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.serviceIdentity ? null : ctx.userId || null,
    action,
    entityType: 'AiRecommendation',
    entityId: rec.id,
    beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' },
    afterJson: auditSnapshot(rec),
    reason,
  }, transaction);
}

// ai.recommendation.created/accepted/rejected saem de events/ (M9-D029), na mesma transação da recomendação.
module.exports = { publishRecommendationEvent, auditRecommendation };
