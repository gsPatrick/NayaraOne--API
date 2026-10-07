'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

// GAP CORRIGIDO (auditoria pós-Marco 6, item 1): o prazo padrão de pós-obra (SLA por
// severidade) estava hardcoded em `SEVERITY_SLA_DAYS` dentro de maintenanceCases.service.js,
// em paralelo ao Motor de Regras genérico já usado por REG-OBR-001 (margem mínima — ver
// marginRules.service.js, mesmo padrão replicado aqui). O catálogo do contrato lista
// explicitamente `REG-OBR-002` ("Prazo padrão de pós-obra") — esta migração move o SLA por
// severidade pra usar o motor genérico de verdade, com ESSE código, preservando o conceito de
// versionamento imutável:
//   - cada chamada a createSlaRule cria uma NOVA RuleVersion (nunca edita uma existente);
//   - a versão anterior nunca é apagada — apenas seu `effectiveUntil` é fechado em `now`;
//   - casos já abertos mantêm o `slaDueAt`/SLA calculado no momento da abertura — trocar a
//     regra só vale para casos novos (ou para recálculo explícito de um caso existente via
//     updateMaintenanceCase, que sempre busca a versão vigente NO MOMENTO da edição — mesmo
//     comportamento que já existia antes desta migração, quando a constante era lida direto).
//
// Diferente de REG-OBR-001, não há nenhuma FK legada apontando para uma tabela própria deste
// módulo — SEVERITY_SLA_DAYS nunca foi persistido em tabela nenhuma, só vivia em memória — então
// não é necessário nenhum espelhamento de compatibilidade aqui.
const RULE_CODE = 'REG-OBR-002';
const RULE_NAME = 'Prazo padrão de pós-obra (SLA por severidade)';
const RULE_DOMAIN = 'construction';
// Condição "sempre ativa" — mesmo padrão de REG-OBR-001/REG-LOC-002/REG-LOC-003: o fato de
// interesse não é "se" a regra vale, é o VALOR (slaDays) carregado na ação.
const CONDITION_AST = { fact: 'slaRuleActive', op: '==', value: true };

// Valores padrão — mesmos já usados antes desta migração (decisão de engenharia original de
// M6-63/M6-88, nenhum documento fonte define os dias exatos). Usados apenas como SEED INICIAL
// da primeira versão publicada de cada tenant — depois de publicada, quem decide o valor é a
// RuleVersion, não esta constante.
const DEFAULT_SLA_DAYS = { CRITICAL: 2, HIGH: 5, MEDIUM: 15, LOW: 30 };
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

function validateSlaDaysMap(slaDays) {
  if (!slaDays || typeof slaDays !== 'object' || Array.isArray(slaDays)) {
    throw AppError.badRequest('"slaDays" deve ser um objeto com os dias de SLA por severidade.', 'SLA_RULE_VALIDATION');
  }
  const normalized = {};
  for (const severity of SEVERITIES) {
    const raw = slaDays[severity];
    if (raw === undefined || raw === null) {
      throw AppError.badRequest(`"slaDays.${severity}" é obrigatório.`, 'SLA_RULE_VALIDATION');
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
      throw AppError.badRequest(`"slaDays.${severity}" deve ser um número inteiro maior que zero.`, 'SLA_RULE_VALIDATION');
    }
    normalized[severity] = numeric;
  }
  return normalized;
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
        description: 'Prazo padrão de atendimento (SLA, em dias) por severidade do chamado de pós-obra/garantia.',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

async function publishSlaRuleVersion(groupId, companyId, slaDaysMap, description, actorUserId, transaction) {
  // Mesma justificativa do advisory lock de REG-OBR-001: serializa por groupId+companyId+
  // ruleCode ANTES de tocar nas linhas, pra evitar corrida entre "fechar versão anterior" e
  // "criar nova versão PUBLISHED".
  const lockKey = `sla_rule:${groupId}:${companyId}:${RULE_CODE}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey },
    transaction,
  });

  const rule = await getOrCreateRule(groupId, companyId, actorUserId, transaction);
  const now = new Date();

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

  const actionJson = { slaDays: slaDaysMap, description: description || null };
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

  return version;
}

async function createSlaRule(payload, actorUserId, transaction) {
  const { groupId, companyId, slaDays, description } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'SLA_RULE_VALIDATION');
  }
  const normalized = validateSlaDaysMap(slaDays);

  const version = await publishSlaRuleVersion(groupId, companyId, normalized, description, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.sla_rule.create',
      entityType: 'RuleVersion',
      entityId: version.id,
      afterJson: { id: version.id, slaDays: normalized, description: description || null, ruleCode: RULE_CODE },
      reason: `Nova versão do SLA de pós-obra (${RULE_CODE}) criada no Motor de Regras genérico.`,
    },
    transaction
  );

  return { id: version.id, groupId, companyId, slaDays: normalized, description: description || null, isActive: true };
}

/**
 * getActiveSlaDaysMap — resolve o mapa de dias de SLA vigente para o tenant via Motor de
 * Regras genérico. Se NENHUMA versão jamais foi publicada para este tenant (primeiro uso,
 * nenhum administrador configurou REG-OBR-002 ainda), semeia automaticamente a primeira versão
 * com `DEFAULT_SLA_DAYS` — preserva o comportamento anterior (constante fixa) como "configuração
 * inicial" sem exigir nenhuma migração manual nem quebrar nenhum caso já testado/existente.
 * Depois dessa semeadura inicial, só `createSlaRule` decide o valor.
 */
async function getActiveSlaDaysMap(groupId, companyId, transaction, actorUserId) {
  let evaluation = await evaluateRule(RULE_CODE, { slaRuleActive: true }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    // Semeia a versão default — idempotente sob corrida via o mesmo advisory lock usado em
    // publishSlaRuleVersion (duas chamadas concorrentes de tenants sem regra configurada nunca
    // criam duas versões "default" simultâneas; a segunda fecha a primeira e publica de novo com
    // os MESMOS valores, o que é inofensivo).
    await publishSlaRuleVersion(groupId, companyId, DEFAULT_SLA_DAYS, 'Valor padrão (seed automático).', actorUserId || null, transaction);
    evaluation = await evaluateRule(RULE_CODE, { slaRuleActive: true }, { groupId, companyId }, { transaction });
  }
  if (evaluation.decision !== 'APPLY') {
    // Fail-closed real do motor (erro de banco etc.) — nunca inventa um SLA silenciosamente.
    throw AppError.unprocessable(
      'Não foi possível resolver o prazo de SLA de pós-obra configurado para esta empresa.',
      'SLA_RULE_NOT_CONFIGURED'
    );
  }
  return {
    ruleVersionId: evaluation.ruleVersionId,
    slaDays: evaluation.action.slaDays,
  };
}

async function getSlaRule(id, transaction) {
  const version = await RuleVersion.findByPk(id, { transaction });
  if (!version) throw AppError.notFound('Regra de SLA não encontrada.', 'SLA_RULE_NOT_FOUND');
  return {
    id: version.id,
    slaDays: version.actionJson?.slaDays || null,
    description: version.actionJson?.description || null,
    isActive: version.status === 'PUBLISHED' && !version.effectiveUntil,
  };
}

module.exports = {
  createSlaRule,
  getActiveSlaDaysMap,
  getSlaRule,
  RULE_CODE,
  DEFAULT_SLA_DAYS,
  SEVERITIES,
};
