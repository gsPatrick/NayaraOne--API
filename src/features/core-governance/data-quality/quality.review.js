'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const { openReviewItem } = require('./merge.detection');
const { REASONS } = require('./merge.constants');
const { SEVERITY_RANK } = require('./quality.constants');
const settings = require('./quality.settings');

/**
 * Consumidor do evento data.quality.issue.opened (M9-D806 §3.3): a issue com severidade igual ou acima de governanca.dados.qualidade.severidade_revisao
 * (padrão CRITICAL) entra na fila de revisão do steward do domínio por openReviewItem (M9-D805). Roda na transação que abriu a issue, com o mesmo
 * payload do evento; um REVIEW aberto por cadastro (o índice único da fila reaproveita o que já existe). Devolve o item criado ou null.
 */
async function handleIssueOpened(tenant, payload, transaction) {
  const threshold = String(await getSetting(settings.REVIEW_SEVERITY_KEY, tenant, transaction, settings.QUALITY_SETTING_DEFAULTS[settings.REVIEW_SEVERITY_KEY]));
  if ((SEVERITY_RANK[payload.severity] || 0) < (SEVERITY_RANK[threshold] || SEVERITY_RANK.CRITICAL)) return null;
  const [row] = await sequelize.query('SELECT score FROM governance.quality_scores WHERE company_id = :companyId AND entity_type = :entityType AND entity_id = :entityId', {
    type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, entityType: payload.entityType, entityId: payload.entityId },
  });
  return openReviewItem(tenant, {
    entityType: payload.entityType, entityId: payload.entityId, reason: REASONS.QUALITY_CRITICAL, score: row ? Number(row.score) : 0,
    evidence: { issueId: payload.issueId, ruleCode: payload.ruleCode, severity: payload.severity },
  }, transaction);
}

module.exports = { handleIssueOpened };
