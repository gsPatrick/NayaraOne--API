'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { sequelize, Rule, RuleVersion, RuleScope, RulePublication } = require('../src/models');

/**
 * seedBillingRules — registra o catálogo de regras do módulo billing de locação (M07 Billing
 * Locação/Utilities, Marco 5), mesmo padrão de scripts/seedRealEstateRules.js.
 *
 *   REG-LOC-001  Multa e juros de atraso                  Calcula multa/juros de uma cobrança
 *                                                          em atraso.
 *   REG-LOC-002  Carência antes de considerar em atraso    Define quantos dias de carência
 *                                                          existem antes de abrir um caso de
 *                                                          cobrança.
 *   REG-LOC-003  Política de aplicação de reajuste         Marca qual versão de regra estava
 *                                                          vigente quando um reajuste (IPCA/
 *                                                          IGPM) foi calculado/gravado.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: o Caderno pede multa/juros/carência via
 * Motor de Regras, mas não define os percentuais/prazos. Usamos os parâmetros mais comuns do
 * mercado de locação residencial brasileiro como default razoável, documentados aqui e
 * plenamente ajustáveis depois via nova RuleVersion publicada (sem alterar código):
 *   - REG-LOC-001: multa de 2% sobre o valor em atraso (limite legal do Código de Defesa do
 *     Consumidor/CC para mora contratual) + juros de mora de 1% ao mês (pro rata dia, calculado
 *     pelo chamador — collectionCase.service.js), condição `{ fact: "isOverdue", op: "==",
 *     value: true }`, ação `{ penaltyPercentage: 2, monthlyInterestPercentage: 1 }`.
 *   - REG-LOC-002: 3 dias corridos de carência após o vencimento antes de considerar a
 *     competência oficialmente em atraso (abrir CollectionCase). A condição só configura QUE a
 *     regra está ativa (`{ fact: "gracePeriodRuleActive", op: "==", value: true }`, sempre
 *     satisfeita pelo fato fixo que o chamador envia) — o NÚMERO de dias de carência vem da
 *     ação (`{ graceDays: 3 }`), nunca do resultado da condição em si (a condição não decide
 *     "quantos dias", só se a regra está publicada/vigente para o tenant).
 *   - REG-LOC-003: mesmo padrão de "regra sempre ativa" que REG-LOC-002 — condição
 *     `{ fact: "rentAdjustmentRuleActive", op: "==", value: true }`, ação
 *     `{ appliedEqualsRawByDefault: true }` (documenta a política já implementada em
 *     rentAdjustment.service.js: o percentual aplicado é igual ao bruto da fonte, salvo
 *     negociação manual explícita via `appliedPercentageOverride`). O ganho aqui não é a
 *     condição em si — é que toda RentAdjustment passa a gravar `ruleVersionId` (evidência de
 *     QUAL versão da política estava vigente quando o reajuste foi calculado), exigido
 *     explicitamente na homologação.
 * Estes valores DEVEM ser confirmados/ajustados pelo cliente antes de produção — ver relatório
 * final da implementação.
 */
const RULES = [
  {
    code: 'REG-LOC-001',
    name: 'Multa e juros de atraso',
    description: 'Calcula multa e juros de mora de uma cobrança de locação em atraso.',
    domain: 'finance',
    conditionAstJson: { fact: 'isOverdue', op: '==', value: true },
    actionJson: { penaltyPercentage: 2, monthlyInterestPercentage: 1 },
  },
  {
    code: 'REG-LOC-002',
    name: 'Carência antes de considerar em atraso',
    description: 'Define quantos dias de carência existem após o vencimento antes de abrir um caso de cobrança.',
    domain: 'finance',
    conditionAstJson: { fact: 'gracePeriodRuleActive', op: '==', value: true },
    actionJson: { graceDays: 3 },
  },
  {
    code: 'REG-LOC-003',
    name: 'Política de aplicação de reajuste',
    description: 'Define a política padrão de aplicação de índice de reajuste (IPCA/IGPM) e serve de evidência de versionamento por reajuste gravado.',
    domain: 'finance',
    conditionAstJson: { fact: 'rentAdjustmentRuleActive', op: '==', value: true },
    actionJson: { appliedEqualsRawByDefault: true },
  },
];

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

async function seedBillingRules({ groupId, companyId, userId }, transaction) {
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
    return seedBillingRules(tenant, transaction);
  });
  // eslint-disable-next-line no-console
  console.log('[seedBillingRules]', JSON.stringify(result, null, 2));
  await sequelize.close();
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seedBillingRules] Falha:', err);
    process.exit(1);
  });
}

module.exports = { seedBillingRules };
