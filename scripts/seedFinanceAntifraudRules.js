'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { sequelize, Rule, RuleVersion, RuleScope, RulePublication } = require('../src/models');

/**
 * seedFinanceAntifraudRules — auditoria externa (contrato bruto, 2026-10-07, Centro Financeiro
 * §2 "Princípios constitucionais", FIN-005: "Limites vêm do Motor de Regras; aprovação usa
 * snapshot/hash."). Antes desta rodada, financeAntifraud.service.js tinha os limiares
 * (multiplicador de desvio histórico, limite de conta nova, cooldown de conta nova/alterada)
 * fixos via `process.env.FINANCE_ANOMALY_*`/`FINANCE_BANK_ACCOUNT_COOLDOWN_HOURS` — nem
 * hard-code puro, nem o Motor de Regras exigido pelo contrato.
 *
 * Mesmo padrão arquitetural de scripts/seedBillingRules.js (REG-LOC-001/002): o Motor de
 * Regras decide SE o limite de antifraude está ativo para o tenant (fail-closed —
 * evaluateRule('FIN-005', ...) DENY = usa o comportamento mais conservador possível); o QUANTO
 * (multiplicador/limite em R$/horas de cooldown) vem de `getSetting(...)` com o valor hardcoded
 * anterior como default — preserva o comportamento atual quando o tenant não configurou nada
 * no painel (settings.service.js SETTINGS_SCHEMA).
 *
 *   FIN-005  Antifraude de pagamento ativo    Define se os limiares de desvio histórico/conta
 *                                              nova/cooldown estão ativos para o tenant.
 */
const RULES = [
  {
    code: 'FIN-005',
    name: 'Antifraude de pagamento ativo',
    description:
      'Define se os limiares de antifraude (desvio histórico de pagamento, limite de primeiro pagamento de conta nova, ' +
      'cooldown de conta bancária nova/alterada) estão ativos para o tenant — valores ajustáveis via painel de settings.',
    domain: 'finance',
    conditionAstJson: { fact: 'financeAntifraudRuleActive', op: '==', value: true },
    actionJson: {
      historyMultiplier: 3,
      newAccountThreshold: 10000,
      bankAccountCooldownHours: 48,
    },
  },
];

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

async function seedFinanceAntifraudRules({ groupId, companyId, userId }, transaction) {
  const now = new Date();
  const created = [];

  for (const spec of RULES) {
    let rule = await Rule.findOne({ where: { code: spec.code, groupId, companyId }, transaction });
    if (!rule) {
      rule = await Rule.create(
        {
          groupId,
          companyId,
          code: spec.code,
          name: spec.name,
          description: spec.description,
          domain: spec.domain,
          createdBy: userId,
          updatedBy: userId,
        },
        { transaction }
      );
    }

    const existingVersion = await RuleVersion.findOne({ where: { ruleId: rule.id, status: 'PUBLISHED' }, transaction });
    if (existingVersion) {
      created.push({ code: spec.code, ruleId: rule.id, ruleVersionId: existingVersion.id, alreadyExisted: true });
      continue;
    }

    const version = await RuleVersion.create(
      {
        groupId,
        companyId,
        ruleId: rule.id,
        versionNumber: 1,
        conditionAstJson: spec.conditionAstJson,
        contentHash: hashCondition(spec.conditionAstJson),
        actionJson: spec.actionJson,
        effectiveFrom: now,
        effectiveUntil: null,
        status: 'PUBLISHED',
        publishedByUserId: userId,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction }
    );

    await RuleScope.create(
      {
        groupId,
        companyId,
        ruleVersionId: version.id,
        scopeType: 'GLOBAL',
        scopeRefId: null,
        precedence: 7,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction }
    );

    await RulePublication.create(
      {
        groupId,
        companyId,
        ruleVersionId: version.id,
        publishedByUserId: userId,
        publishedAt: now,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction }
    );

    created.push({ code: spec.code, ruleId: rule.id, ruleVersionId: version.id, alreadyExisted: false });
  }

  return created;
}

async function main() {
  const { getSeedTenant } = require('../test/testHelpers');
  const tenant = await getSeedTenant();
  const result = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    return seedFinanceAntifraudRules(tenant, transaction);
  });
  // eslint-disable-next-line no-console
  console.log('[seedFinanceAntifraudRules]', JSON.stringify(result, null, 2));
  await sequelize.close();
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seedFinanceAntifraudRules] Falha:', err);
    process.exit(1);
  });
}

module.exports = { seedFinanceAntifraudRules };
