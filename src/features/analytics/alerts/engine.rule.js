'use strict';

/**
 * M9-D691 (3.1 passo 3) — condição por regra do Motor de Regras: chama `src/engines/rules` com o contexto { metric, value, previous, scope, asOf }
 * e usa a decisão da regra PUBLICADA (regra em rascunho ou aposentada nunca roda: 422 ANALYTICS_ALERT_RULE_NOT_PUBLISHED). A avaliação é pura:
 * só depende do snapshot e do contexto.
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { evaluateRule } = require('../../../engines/rules/rulesEngine');

const NOT_PUBLISHED = () => AppError.unprocessable('A regra escolhida não está publicada.', 'ANALYTICS_ALERT_RULE_NOT_PUBLISHED');
const NOT_PUBLISHED_REASONS = new Set(['RULE_NOT_FOUND', 'RULE_NO_ACTIVE_VERSION']);

/** { code, version }: o código da regra e o número da versão PUBLISHED mais nova; sem versão publicada, 422. */
async function publishedRule(ruleId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT r.code, v.version_number AS version FROM core.rules r JOIN core.rule_versions v ON v.rule_id = r.id AND v.status = 'PUBLISHED'
      WHERE r.id = :ruleId AND r.deleted_at IS NULL ORDER BY v.version_number DESC LIMIT 1`,
    { replacements: { ruleId }, transaction }
  );
  if (!rows[0]) throw NOT_PUBLISHED();
  return { code: rows[0].code, version: Number(rows[0].version) };
}

/** true quando a regra se aplica (APPLY). */
async function ruleHolds(rule, input, def, scope, { now }, transaction) {
  const context = {
    metric: def.metric_code, value: Number(input.value), previous: input.previous && input.previous.value_numeric !== null ? Number(input.previous.value_numeric) : null,
    scope: { ...(def.scope || {}), companyId: scope.companyId }, asOf: String(input.snapshot.as_of_date),
  };
  const out = await evaluateRule(rule.code, context, { groupId: scope.groupId, companyId: scope.companyId }, { transaction, now });
  if (out.decision === 'APPLY') return true;
  if (NOT_PUBLISHED_REASONS.has(out.reason)) throw NOT_PUBLISHED();
  if (['RULE_CONFLICT', 'RULE_EVALUATION_ERROR', 'RULE_ENGINE_ERROR', 'RULE_CONTEXT_MISSING'].includes(out.reason)) {
    throw AppError.unprocessable('A regra do alerta não pôde ser avaliada.', 'ANALYTICS_ALERT_RULE_FAILED', { reason: out.reason });
  }
  return false;
}

module.exports = { publishedRule, ruleHolds };
