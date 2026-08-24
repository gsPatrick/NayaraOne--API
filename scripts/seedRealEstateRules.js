'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { sequelize, Rule, RuleVersion, RuleScope, RulePublication } = require('../src/models');

/**
 * seedRealEstateRules — registra o catálogo confirmado pelo Caderno Técnico para o domínio
 * Imóveis:
 *
 *   REG-IMO-001  Vídeo obrigatório para publicação   BOOLEAN   Bloqueia publicação.
 *   REG-IMO-002  Imóvel sem venda por período         DURATION  Gerar alerta de revisão.
 *
 * "core"."rules"/"rule_versions"/"rule_scopes" são tabelas MULTIEMPRESA (group_id/company_id
 * NOT NULL) — não há como inserir um "catálogo global" via migration de schema sem já saber o
 * tenant. Por isso este catálogo é semeado por script (idempotente, seguro para rodar mais de
 * uma vez) por tenant, em vez de uma migration de dados fixa — decisão documentada em
 * src/documentacao/features/Properties.md.
 *
 * REG-IMO-001: condição `{ fact: "hasVideo", op: "==", value: true }` — o chamador
 * (publish.service.js) resolve `hasVideo` consultando "real_estate"."property_media" antes de
 * invocar `evaluateRule`, e só permite a publicação quando a avaliação retorna
 * `{ decision: 'APPLY' }`. Fail-closed: se REG-IMO-001 não estiver semeada para o tenant, ou o
 * banco estiver indisponível, `evaluateRule` já retorna DENY por padrão (rulesEngine.js) — a
 * publicação fica bloqueada, nunca liberada por omissão.
 *
 * REG-IMO-002: apenas registro da regra (DURATION) + versão publicada, sem scheduler novo
 * (fora de escopo desta tarefa) — condição de exemplo `{ fact: "daysWithoutSale", op: ">=",
 * value: 90 }` com ação `{ alert: "REVIEW_STALE_LISTING" }`, chamável via evaluateRule por
 * quem quiser implementar o alerta futuramente.
 */

const RULES = [
  {
    code: 'REG-IMO-001',
    name: 'Vídeo obrigatório para publicação',
    description: 'Bloqueia a publicação de um imóvel se não houver ao menos um vídeo cadastrado em property_media.',
    domain: 'real_estate',
    conditionAstJson: { fact: 'hasVideo', op: '==', value: true },
    actionJson: { allow: true, reason: 'VIDEO_REQUIRED_FOR_PUBLICATION' },
  },
  {
    code: 'REG-IMO-002',
    name: 'Imóvel sem venda por período',
    description: 'Gera alerta de revisão quando um imóvel permanece sem venda/negociação além do período configurado.',
    domain: 'real_estate',
    conditionAstJson: { fact: 'daysWithoutSale', op: '>=', value: 90 },
    actionJson: { alert: 'REVIEW_STALE_LISTING' },
  },
];

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

async function seedImoRules({ groupId, companyId, userId }, transaction) {
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

    const existingVersion = await RuleVersion.findOne({
      where: { ruleId: rule.id, status: 'PUBLISHED' },
      transaction,
    });
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
    return seedImoRules(tenant, transaction);
  });
  // eslint-disable-next-line no-console
  console.log('[seedRealEstateRules]', JSON.stringify(result, null, 2));
  await sequelize.close();
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seedRealEstateRules] Falha:', err);
    process.exit(1);
  });
}

module.exports = { seedImoRules };
