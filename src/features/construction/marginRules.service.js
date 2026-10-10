'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, MarginRule, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

// GAP CORRIGIDO (auditoria pós-Marco 6, item 4): a margem mínima da obra era versionada numa
// tabela própria do módulo (`construction.margin_rules`), em paralelo ao Motor de Regras
// genérico (`core.rules`/`evaluateRule`) já usado por REG-IMO-001, REG-LOC-001/002, FIN-005
// etc. O catálogo do contrato já lista explicitamente `REG-OBR-001` ("Lucro mínimo da obra",
// tipo PERCENTAGE, domínio Construção) — esta migração move a margem mínima pra usar o motor
// genérico de verdade, com ESSE código, preservando o conceito de versionamento imutável:
//   - cada chamada a createMarginRule cria uma NOVA RuleVersion (nunca edita uma existente);
//   - a versão anterior nunca é apagada — apenas seu `effectiveUntil` é fechado em `now`, que é
//     a forma window-based do motor genérico de "desativar sem apagar" (equivalente ao
//     `isActive=false` da tabela antiga, mas no vocabulário do motor);
//   - `rule_version_id` gravado no orçamento aprovado (ver budgets.service.js) agora aponta
//     para `core.rule_versions.id` — uma versão do Motor de Regras genérico — não mais para
//     `construction.margin_rules.id`.
//
// LIMITAÇÃO DE AMBIENTE DOCUMENTADA (honesta, não escondida): `construction.budgets.rule_
// version_id` tem uma FOREIGN KEY de banco para `construction.margin_rules.id`
// (migrations/20260101000182-create-construction-budgets.js) — mudar essa FK para apontar para
// `core.rule_versions` exigiria uma migration (`ALTER TABLE ... DROP/ADD CONSTRAINT`), e este
// ambiente de execução não tem permissão para rodar migrations contra o banco compartilhado
// (`ERROR: permission denied for schema public` com o usuário de runtime; tentativas com o
// usuário de migração dedicado também foram bloqueadas pela política de execução do agente).
// Solução de compatibilidade SEM migration: a cada nova versão publicada no Motor de Regras
// genérico, espelhamos uma linha em `construction.margin_rules` com O MESMO id da RuleVersion
// (`MarginRule.id === RuleVersion.id`) — só para a FK de `budgets.rule_version_id` continuar
// íntegra. Essa linha espelho NUNCA é lida para decidir nada (getActiveMarginRule/
// projectHealth.service.js leem exclusivamente via `evaluateRule('REG-OBR-001', ...)`) — é
// puro suporte de integridade referencial herdada. Quando uma migration puder ser aplicada,
// o caminho correto é: `ALTER TABLE construction.budgets DROP CONSTRAINT <fk>, ADD CONSTRAINT
// ... REFERENCES core.rule_versions(id)`, e então este espelhamento pode ser removido.
const RULE_CODE = 'REG-OBR-001';
const RULE_NAME = 'Lucro mínimo da obra';
const RULE_DOMAIN = 'construction';
// Condição "sempre ativa" — mesmo padrão de REG-LOC-002/REG-LOC-003 (scripts/seedBillingRules.js):
// o fato de interesse não é "se" a regra vale, é o VALOR (minMarginPct) carregado na ação. O
// motor sempre casa quando há uma versão publicada vigente para o escopo.
const CONDITION_AST = { fact: 'marginRuleActive', op: '==', value: true };

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

async function getOrCreateRule(groupId, companyId, actorUserId, transaction) {
  let rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
  if (!rule) {
    rule = await Rule.create(
      {
        groupId,
        companyId,
        code: RULE_CODE,
        name: RULE_NAME,
        description: 'Margem mínima exigida da obra — margem abaixo da regra gera alerta (bloqueio configurado em getProjectHealth).',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

async function createMarginRuleAttempt(groupId, companyId, numeric, description, actorUserId, transaction, economyPct, commissionPct, enforcementMode) {
  // Mesma justificativa do pg_advisory_xact_lock original (migração 20260101000181): o par
  // "fechar effectiveUntil da versão anterior" + "criar nova RuleVersion PUBLISHED" sob
  // concorrência real da mesma empresa pode formar condição de corrida — serializa por
  // groupId+companyId+ruleCode ANTES de tocar nas linhas.
  const lockKey = `margin_rule:${groupId}:${companyId}:${RULE_CODE}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey },
    transaction,
  });

  const rule = await getOrCreateRule(groupId, companyId, actorUserId, transaction);
  const now = new Date();

  // Fecha a janela de vigência da versão PUBLISHED ainda aberta (equivalente a isActive=false
  // na tabela antiga) — NUNCA edita conteúdo/condição/ação de uma versão já publicada.
  await RuleVersion.update(
    { effectiveUntil: now, updatedBy: actorUserId || null },
    { where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction }
  );

  const lastVersion = await RuleVersion.findOne({
    where: { ruleId: rule.id },
    order: [['versionNumber', 'DESC']],
    transaction,
  });
  const nextVersionNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

  const actionJson = {
    minMarginPct: numeric,
    description: description || null,
    economyPct: economyPct === undefined ? null : economyPct,
    commissionPct: commissionPct === undefined ? null : commissionPct,
    enforcementMode: enforcementMode || DEFAULT_ENFORCEMENT_MODE,
  };
  const version = await RuleVersion.create(
    {
      groupId,
      companyId,
      ruleId: rule.id,
      versionNumber: nextVersionNumber,
      conditionAstJson: CONDITION_AST,
      contentHash: hashCondition(CONDITION_AST),
      actionJson,
      effectiveFrom: now,
      effectiveUntil: null,
      status: 'PUBLISHED',
      publishedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
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
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await RulePublication.create(
    {
      groupId,
      companyId,
      ruleVersionId: version.id,
      publishedByUserId: actorUserId || null,
      publishedAt: now,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  // Espelho de compatibilidade para a FK legada (ver comentário de topo do arquivo) — nunca
  // lido para decisão de negócio, só para `construction.budgets.rule_version_id` continuar
  // referenciando uma linha válida sem precisar de migration.
  await MarginRule.update({ isActive: false, updatedBy: actorUserId || null }, { where: { groupId, companyId, isActive: true }, transaction });
  await MarginRule.create(
    {
      id: version.id,
      groupId,
      companyId,
      minMarginPct: numeric,
      description: description || null,
      isActive: true,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  // Forma compatível com o shape antigo (MarginRule) que os chamadores (budgets.service.js,
  // projectHealth.service.js, front) já esperam — `id` agora É o `rule_version_id` do Motor de
  // Regras genérico.
  return {
    id: version.id,
    groupId,
    companyId,
    minMarginPct: numeric,
    description: description || null,
    economyPct: actionJson.economyPct,
    commissionPct: actionJson.commissionPct,
    enforcementMode: actionJson.enforcementMode,
    isActive: true,
    toJSON() {
      return {
        id: version.id,
        groupId,
        companyId,
        minMarginPct: numeric,
        description: description || null,
        economyPct: actionJson.economyPct,
        commissionPct: actionJson.commissionPct,
        enforcementMode: actionJson.enforcementMode,
        isActive: true,
        ruleCode: RULE_CODE,
      };
    },
  };
}

// TAREFA 2 (auditoria externa Nayara, fechamento Marco 6): valida "economyPct"/"commissionPct"
// com a MESMA regra já usada pra "minMarginPct" (campo opcional — null/undefined é válido e
// significa "regra não configurada"; quando informado, tem que ser um percentual numérico
// finito entre 0 e 100 — nunca NaN/Infinity/negativo/acima de 100, mesma classe de bug já
// catalogada na categoria 14 do catálogo de auditoria).
function validateOptionalPct(value, fieldName) {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw AppError.badRequest(`"${fieldName}" deve ser um percentual numérico entre 0 e 100.`, 'MARGIN_RULE_VALIDATION');
  }
  return numeric;
}

// TAREFA (auditoria externa Nayara, item A9/caderno técnico p.161 seção 5): "Margem abaixo da
// regra gera alerta ou bloqueio, conforme configurado" — até aqui só existia o ALERTA
// (belowMinMargin em projectHealth.service.js, nunca bloqueava nada). `enforcementMode`
// determina se a margem projetada abaixo de `minMarginPct` apenas sinaliza (ALERT, default —
// preserva 100% o comportamento anterior) ou IMPEDE a aprovação (BLOCK) nos pontos de decisão
// reais (budgets.service.js#approveBudget, changeOrders.service.js#decideChangeOrder). Mesmo
// padrão de validação/persistência de economyPct/commissionPct: campo plano dentro do MESMO
// actionJson da RuleVersion do Motor de Regras genérico — nenhum mecanismo novo.
const ENFORCEMENT_MODES = ['ALERT', 'BLOCK'];
const DEFAULT_ENFORCEMENT_MODE = 'ALERT';

function validateEnforcementMode(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_ENFORCEMENT_MODE;
  const normalized = String(value).toUpperCase();
  if (!ENFORCEMENT_MODES.includes(normalized)) {
    throw AppError.badRequest(
      `"enforcementMode" deve ser um dos valores: ${ENFORCEMENT_MODES.join(', ')}.`,
      'MARGIN_RULE_VALIDATION'
    );
  }
  return normalized;
}

async function createMarginRule(payload, actorUserId, transaction) {
  const { groupId, companyId, minMarginPct, description, economyPct, commissionPct, enforcementMode } = payload;
  if (!groupId || !companyId || minMarginPct === undefined || minMarginPct === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId" e "minMarginPct" são obrigatórios.',
      'MARGIN_RULE_VALIDATION'
    );
  }
  const numeric = Number(minMarginPct);
  // FIX (auditoria E2E de browser, ciclo 2, 01/10/2026): mesma trava de negócio preservada na
  // migração pro Motor de Regras — nunca inventa um teto diferente do já decidido.
  if (Number.isNaN(numeric) || numeric < 0 || numeric > 100) {
    throw AppError.badRequest('"minMarginPct" deve ser um percentual numérico entre 0 e 100.', 'MARGIN_RULE_VALIDATION');
  }
  const economyNumeric = validateOptionalPct(economyPct, 'economyPct');
  const commissionNumeric = validateOptionalPct(commissionPct, 'commissionPct');
  const enforcementModeValidated = validateEnforcementMode(enforcementMode);

  const rule = await createMarginRuleAttempt(
    groupId,
    companyId,
    numeric,
    description,
    actorUserId,
    transaction,
    economyNumeric,
    commissionNumeric,
    enforcementModeValidated
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.margin_rule.create',
      entityType: 'RuleVersion',
      entityId: rule.id,
      afterJson: rule.toJSON(),
      reason: `Nova versão de margem mínima (${RULE_CODE}) criada no Motor de Regras genérico (${numeric}%).`,
    },
    transaction
  );

  return rule;
}

async function getActiveMarginRule(groupId, companyId, transaction) {
  const evaluation = await evaluateRule(RULE_CODE, { marginRuleActive: true }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Não há margem mínima configurada para esta empresa — configure uma versão de regra antes de aprovar orçamento.',
      'MARGIN_RULE_NOT_CONFIGURED'
    );
  }
  return {
    id: evaluation.ruleVersionId,
    minMarginPct: Number(evaluation.action.minMarginPct),
    description: evaluation.action.description || null,
    economyPct: evaluation.action.economyPct !== undefined && evaluation.action.economyPct !== null
      ? Number(evaluation.action.economyPct)
      : null,
    commissionPct: evaluation.action.commissionPct !== undefined && evaluation.action.commissionPct !== null
      ? Number(evaluation.action.commissionPct)
      : null,
    enforcementMode: evaluation.action.enforcementMode || DEFAULT_ENFORCEMENT_MODE,
    isActive: true,
  };
}

async function getMarginRule(id, transaction) {
  const version = await RuleVersion.findByPk(id, { transaction });
  if (!version) throw AppError.notFound('Regra de margem não encontrada.', 'MARGIN_RULE_NOT_FOUND');
  return {
    id: version.id,
    minMarginPct: Number(version.actionJson?.minMarginPct),
    description: version.actionJson?.description || null,
    economyPct: version.actionJson?.economyPct !== undefined && version.actionJson?.economyPct !== null
      ? Number(version.actionJson.economyPct)
      : null,
    commissionPct: version.actionJson?.commissionPct !== undefined && version.actionJson?.commissionPct !== null
      ? Number(version.actionJson.commissionPct)
      : null,
    enforcementMode: version.actionJson?.enforcementMode || DEFAULT_ENFORCEMENT_MODE,
    isActive: version.status === 'PUBLISHED' && !version.effectiveUntil,
  };
}

module.exports = {
  createMarginRule,
  getActiveMarginRule,
  getMarginRule,
  RULE_CODE,
  ENFORCEMENT_MODES,
  DEFAULT_ENFORCEMENT_MODE,
};
