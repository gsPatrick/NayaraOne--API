'use strict';

const { Op } = require('sequelize');
const { Rule, RuleVersion, RuleScope } = require('../../models');

/**
 * Resolução de versão/precedência de regra (03_MOTORES_TRANSVERSAIS.md §1) — puramente sobre
 * "qual RuleVersion (se alguma) se aplica a este contexto?", sem avaliar a condição em si (isso
 * é responsabilidade de ruleEvaluator.js) e sem decidir a ação a tomar (rulesEngine.js).
 *
 * `resolveApplicableVersion(ruleCode, context, tenant, now, transaction)` retorna:
 *   - `{ ok: true, version }` quando exatamente uma RuleVersion mais específica se aplica;
 *   - `{ ok: false, reason }` em qualquer outro caso (regra inexistente, sem versão vigente,
 *     nenhum escopo aplicável, ou conflito de precedência empatada — RULE_CONFLICT).
 *
 * `transaction` é OPCIONAL, mas deve ser passado sempre que o chamador já está de posse de
 * uma transação de tenant aberta por `req.withTenantTransaction` (que faz `SET LOCAL
 * app.group_id/app.company_id`, escopado à transação) — sem ele, estas queries rodam em outra
 * conexão do pool sem esse contexto de sessão, e a RLS de "core"."rules" (etc.) bloqueia por
 * padrão qualquer leitura (o que resulta em RULE_NOT_FOUND mesmo com a regra existindo — fail
 * closed continua valendo, mas nunca resolve com sucesso).
 */
async function resolveApplicableVersion(ruleCode, context, tenant, now, transaction) {
  const { groupId, companyId } = tenant || {};

  if (!ruleCode || !groupId || !companyId) {
    return { ok: false, reason: 'RULE_CONTEXT_MISSING' };
  }

  const rule = await Rule.findOne({ where: { code: ruleCode, groupId, companyId }, transaction });
  if (!rule) {
    return { ok: false, reason: 'RULE_NOT_FOUND' };
  }

  const versions = await RuleVersion.findAll({
    where: {
      ruleId: rule.id,
      status: 'PUBLISHED',
      effectiveFrom: { [Op.lte]: now },
      [Op.or]: [{ effectiveUntil: null }, { effectiveUntil: { [Op.gte]: now } }],
    },
    transaction,
  });

  if (versions.length === 0) {
    return { ok: false, reason: 'RULE_NO_ACTIVE_VERSION' };
  }

  const versionIds = versions.map((v) => v.id);
  const scopes = await RuleScope.findAll({ where: { ruleVersionId: versionIds }, transaction });
  const applicable = scopes.filter((scope) => scopeMatches(scope, context));

  if (applicable.length === 0) {
    return { ok: false, reason: 'RULE_NO_MATCHING_SCOPE' };
  }

  const minPrecedence = Math.min(...applicable.map((s) => s.precedence));
  const mostSpecific = applicable.filter((s) => s.precedence === minPrecedence);

  if (mostSpecific.length > 1) {
    return { ok: false, reason: 'RULE_CONFLICT' };
  }

  const chosenVersion = versions.find((v) => v.id === mostSpecific[0].ruleVersionId);
  return { ok: true, version: chosenVersion };
}

function scopeMatches(scope, context) {
  switch (scope.scopeType) {
    case 'GLOBAL':
      return true;
    case 'GROUP':
      return scope.scopeRefId === context.groupId;
    case 'COMPANY':
      return scope.scopeRefId === context.companyId;
    case 'UNIT':
      return scope.scopeRefId === context.unitId;
    case 'DEPARTMENT':
      return scope.scopeRefId === context.departmentId;
    case 'USER':
      return scope.scopeRefId === context.userId;
    case 'OBJECT':
      return scope.scopeRefId === context.objectId;
    default:
      return false;
  }
}

module.exports = { resolveApplicableVersion };
