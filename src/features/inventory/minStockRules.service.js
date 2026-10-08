'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, InventoryItem, InventoryLocation, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

// GAP CORRIGIDO (auditoria de conformidade Marco 7 contra o contrato bruto, EST-012: "Estoque
// mínimo e reposição vêm do Motor de Regras"): o limiar de estoque mínimo era lido direto de uma
// coluna estática (`inventory.inventory_items.minimum_quantity`) em movements.service.js, em
// paralelo ao Motor de Regras genérico (`core.rules`/`evaluateRule`) já usado por REG-OBR-001
// (margem mínima — marginRules.service.js) e REG-OBR-002 (SLA de pós-obra — slaRules.service.js).
// Mesma classe de achado, mesma correção: a política de estoque mínimo/reposição passa a ser a
// regra `REG-EST-001` do Motor de Regras genérico, com o mesmo versionamento imutável:
//   - cada chamada a createMinStockRule cria uma NOVA RuleVersion (nunca edita uma existente);
//   - a versão anterior DO MESMO ESCOPO nunca é apagada — apenas seu `effectiveUntil` é fechado;
//   - o evento `inventory.stock.low` (movements.service.js) passa a usar exclusivamente o limiar
//     resolvido por `evaluateRule('REG-EST-001', ...)`.
//
// ESCOPO — "política por item/local" (decisão de engenharia documentada):
// O resolvedor do motor (ruleResolver.js) escolhe UMA versão por contexto pela menor
// `precedence` entre as RuleScope aplicáveis, e as várias RuleScope de uma mesma versão são
// combinadas por OU (qualquer linha que casa torna a versão aplicável) — não existe escopo
// composto "item E local" no motor, e nenhuma regra existente neste código usa mais de uma
// dimensão. Duas versões OBJECT vigentes para o mesmo item (uma "item" e outra "item+local")
// cairiam em RULE_CONFLICT (fail-closed). Por isso:
//   - a dimensão ITEM é o escopo do motor: RuleScope `OBJECT` com `scopeRefId = inventoryItemId`
//     (precedence 1, o nível mais específico da hierarquia objeto > usuário > ... > global);
//   - a dimensão LOCAL é carregada DENTRO da ação versionada do item: `actionJson.byLocation =
//     { [locationId]: minimumQuantity }` sobrepõe o mínimo padrão do item naquele local. Uma
//     política de item é sempre publicada inteira (padrão + overrides por local) como uma única
//     versão imutável — o histórico de "quem mudou o mínimo do item X no canteiro Y e quando"
//     continua 100% no versionamento do motor, sem mudar nada no motor compartilhado.
//   - escopo `GLOBAL` (precedence 7) é a política padrão da empresa, semeada automaticamente no
//     primeiro uso (mesmo padrão de getActiveSlaDaysMap em slaRules.service.js) com
//     `minimumQuantity: null` = "sem política de mínimo" (nenhum aviso) — o mesmo comportamento
//     que um item sem `minimum_quantity` já tinha antes desta migração.
//
// ESPELHO DE COMPATIBILIDADE (mesmo padrão de marginRules.service.js / MarginRule): a coluna
// `inventory_items.minimum_quantity` NÃO é removida (remover exigiria migration DDL, que a
// credencial de runtime deste ambiente não pode aplicar — mesma limitação documentada em
// marginRules.service.js). Ela vira um espelho:
//   - a cada versão de item publicada aqui, o mínimo PADRÃO do item é espelhado na coluna, só
//     para leitores legados (listagem do front, relatórios) continuarem mostrando o valor certo;
//   - a coluna NUNCA é lida para decidir aviso de estoque baixo — exceto UMA vez, como semente:
//     item que já tinha `minimum_quantity` antes desta migração (e ainda não tem versão própria
//     no motor) tem esse valor publicado como sua versão 1 no primeiro uso (mesma ideia do seed
//     de DEFAULT_SLA_DAYS — preserva o comportamento anterior sem migração manual de dados).
//     Depois disso, só createMinStockRule decide o valor.
const RULE_CODE = 'REG-EST-001';
const RULE_NAME = 'Estoque mínimo e reposição (política por item/local)';
const RULE_DOMAIN = 'inventory';
// Condição "sempre ativa" — mesmo padrão de REG-OBR-001/REG-OBR-002: o fato de interesse não é
// "se" a regra vale, é o VALOR (minimumQuantity/reorderQuantity/byLocation) carregado na ação.
const CONDITION_AST = { fact: 'minStockRuleActive', op: '==', value: true };

const PRECEDENCE_OBJECT = 1;
const PRECEDENCE_GLOBAL = 7;
const POLICY_SOURCE_ITEM = 'ITEM';
const POLICY_SOURCE_DEFAULT = 'DEFAULT';

// Seed inicial da política padrão da empresa — "sem mínimo configurado" (nenhum aviso), que é
// exatamente o comportamento de um item sem minimum_quantity antes desta migração.
const DEFAULT_POLICY = { minimumQuantity: null, reorderQuantity: null, byLocation: {} };

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

function normalizeQuantity(raw, fieldLabel) {
  if (raw === undefined || raw === null || raw === '') return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw AppError.badRequest(`"${fieldLabel}" precisa ser um número >= 0.`, 'MIN_STOCK_RULE_VALIDATION');
  }
  return numeric;
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
        description: 'Estoque mínimo (e quantidade de reposição) por item, com sobreposição opcional por local — saldo abaixo do mínimo dispara inventory.stock.low.',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

function lockKeyFor(groupId, companyId, scopeRefId) {
  return `min_stock_rule:${groupId}:${companyId}:${RULE_CODE}:${scopeRefId || 'GLOBAL'}`;
}

async function acquireLock(groupId, companyId, scopeRefId, transaction) {
  // Mesma justificativa do advisory lock de REG-OBR-001/REG-OBR-002: serializa "fechar versão
  // anterior" + "criar nova versão PUBLISHED" — aqui por escopo (item ou global), já que cada item
  // tem sua própria linha do tempo de versões dentro da mesma regra.
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey: lockKeyFor(groupId, companyId, scopeRefId) },
    transaction,
  });
}

async function findOpenVersionIdsForScope(ruleId, scopeType, scopeRefId, transaction) {
  const openVersions = await RuleVersion.findAll({
    where: { ruleId, status: 'PUBLISHED', effectiveUntil: null },
    attributes: ['id'],
    transaction,
  });
  if (openVersions.length === 0) return [];
  const scopes = await RuleScope.findAll({
    where: { ruleVersionId: openVersions.map((v) => v.id), scopeType, scopeRefId: scopeRefId || null },
    attributes: ['ruleVersionId'],
    transaction,
  });
  return scopes.map((s) => s.ruleVersionId);
}

/**
 * publishPolicyVersion — publica uma nova RuleVersion de REG-EST-001 para UM escopo (item ou
 * global), fechando apenas a(s) versão(ões) aberta(s) desse MESMO escopo. Chamador já deve ter
 * adquirido o advisory lock do escopo.
 */
async function publishPolicyVersion(groupId, companyId, scope, policy, description, actorUserId, transaction) {
  const rule = await getOrCreateRule(groupId, companyId, actorUserId, transaction);
  const now = new Date();
  // Fecha a versão anterior 1 ms ANTES do início da nova: o resolvedor usa `effectiveUntil >=
  // now`, então fechar exatamente em `now` deixaria as duas versões vigentes no mesmo
  // milissegundo (RULE_CONFLICT) para uma avaliação imediatamente seguinte na mesma transação.
  const closedAt = new Date(now.getTime() - 1);

  const previousIds = await findOpenVersionIdsForScope(rule.id, scope.scopeType, scope.scopeRefId, transaction);
  if (previousIds.length > 0) {
    await RuleVersion.update(
      { effectiveUntil: closedAt, updatedBy: actorUserId || null },
      { where: { id: previousIds }, transaction }
    );
  }

  const lastVersion = await RuleVersion.findOne({
    where: { ruleId: rule.id },
    order: [['versionNumber', 'DESC']],
    transaction,
  });
  const nextVersionNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

  const actionJson = {
    policySource: scope.scopeType === 'OBJECT' ? POLICY_SOURCE_ITEM : POLICY_SOURCE_DEFAULT,
    inventoryItemId: scope.scopeType === 'OBJECT' ? scope.scopeRefId : null,
    minimumQuantity: policy.minimumQuantity,
    reorderQuantity: policy.reorderQuantity,
    byLocation: policy.byLocation || {},
    description: description || null,
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
      scopeType: scope.scopeType,
      scopeRefId: scope.scopeRefId || null,
      precedence: scope.scopeType === 'OBJECT' ? PRECEDENCE_OBJECT : PRECEDENCE_GLOBAL,
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

async function normalizeByLocation(byLocation, companyId, transaction) {
  if (byLocation === undefined || byLocation === null) return {};
  if (typeof byLocation !== 'object' || Array.isArray(byLocation)) {
    throw AppError.badRequest('"byLocation" deve ser um objeto { [locationId]: quantidadeMínima }.', 'MIN_STOCK_RULE_VALIDATION');
  }
  const normalized = {};
  const locationIds = Object.keys(byLocation);
  if (locationIds.length === 0) return normalized;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const locationId of locationIds) {
    if (!uuidPattern.test(locationId)) {
      throw AppError.badRequest(`"byLocation": "${locationId}" não é um id de local válido.`, 'MIN_STOCK_RULE_VALIDATION');
    }
  }
  const locations = await InventoryLocation.findAll({ where: { id: locationIds, companyId }, attributes: ['id'], transaction });
  const found = new Set(locations.map((l) => l.id));
  for (const locationId of locationIds) {
    if (!found.has(locationId)) {
      throw AppError.badRequest(`"byLocation": local ${locationId} não encontrado nesta empresa.`, 'MIN_STOCK_RULE_LOCATION_NOT_FOUND');
    }
    const qty = normalizeQuantity(byLocation[locationId], `byLocation.${locationId}`);
    // null explícito num local = "remover o override" (o local volta a usar o mínimo padrão do item).
    if (qty !== null) normalized[locationId] = qty;
  }
  return normalized;
}

/**
 * createMinStockRule — publica a política de estoque mínimo/reposição de UM item como nova
 * versão de REG-EST-001 (escopo OBJECT = item), com overrides opcionais por local. Espelha o
 * mínimo padrão em `inventory_items.minimum_quantity` (ver comentário de topo).
 */
async function createMinStockRule(payload, actorUserId, transaction, { skipAudit = false } = {}) {
  const { groupId, companyId, inventoryItemId, minimumQuantity, reorderQuantity, byLocation, description } = payload || {};
  if (!groupId || !companyId || !inventoryItemId) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "inventoryItemId" são obrigatórios.', 'MIN_STOCK_RULE_VALIDATION');
  }
  const item = await InventoryItem.findByPk(inventoryItemId, { transaction });
  if (!item || item.companyId !== companyId) {
    throw AppError.notFound('Item de estoque não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');
  }
  if (item.itemType === 'SERVICE_ITEM') {
    throw AppError.badRequest('Item do tipo "SERVICE_ITEM" não tem saldo físico — não admite política de estoque mínimo.', 'MIN_STOCK_RULE_SERVICE_ITEM_FORBIDDEN');
  }

  const policy = {
    minimumQuantity: normalizeQuantity(minimumQuantity, 'minimumQuantity'),
    reorderQuantity: normalizeQuantity(reorderQuantity, 'reorderQuantity'),
    byLocation: await normalizeByLocation(byLocation, companyId, transaction),
  };

  await acquireLock(groupId, companyId, inventoryItemId, transaction);
  const version = await publishPolicyVersion(
    groupId,
    companyId,
    { scopeType: 'OBJECT', scopeRefId: inventoryItemId },
    policy,
    description,
    actorUserId,
    transaction
  );

  // Espelho de compatibilidade — nunca lido para decidir aviso (ver comentário de topo).
  if (String(item.minimumQuantity ?? '') !== String(policy.minimumQuantity ?? '')) {
    await InventoryItem.update(
      { minimumQuantity: policy.minimumQuantity, updatedBy: actorUserId || null },
      { where: { id: inventoryItemId }, transaction }
    );
  }

  const result = {
    id: version.id,
    ruleCode: RULE_CODE,
    versionNumber: version.versionNumber,
    inventoryItemId,
    source: POLICY_SOURCE_ITEM,
    ...policy,
    description: description || null,
    isActive: true,
  };

  if (!skipAudit) {
    await registrarAuditoria(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'inventory.min_stock_rule.create',
        entityType: 'RuleVersion',
        entityId: version.id,
        afterJson: result,
        reason: `Nova versão da política de estoque mínimo (${RULE_CODE}) do item ${inventoryItemId} publicada no Motor de Regras genérico.`,
      },
      transaction
    );
  }

  return result;
}

function toPolicy(evaluation, inventoryItemId) {
  const action = evaluation.action || {};
  return {
    ruleCode: RULE_CODE,
    ruleVersionId: evaluation.ruleVersionId,
    inventoryItemId,
    source: action.policySource === POLICY_SOURCE_ITEM ? POLICY_SOURCE_ITEM : POLICY_SOURCE_DEFAULT,
    minimumQuantity: action.minimumQuantity == null ? null : Number(action.minimumQuantity),
    reorderQuantity: action.reorderQuantity == null ? null : Number(action.reorderQuantity),
    byLocation: action.byLocation || {},
  };
}

function evaluateFor(item, locationId, transaction) {
  return evaluateRule(
    RULE_CODE,
    { minStockRuleActive: true, objectId: item.id, inventoryItemId: item.id, locationId: locationId || null },
    { groupId: item.groupId, companyId: item.companyId },
    { transaction }
  );
}

/**
 * getMinStockPolicy — resolve a política de estoque mínimo vigente de um item via Motor de
 * Regras genérico (REG-EST-001). Semeadura automática no primeiro uso, mesmo padrão de
 * getActiveSlaDaysMap (slaRules.service.js):
 *   1. nenhuma versão jamais publicada para a empresa → publica a política padrão GLOBAL
 *      (`DEFAULT_POLICY`, "sem mínimo");
 *   2. item sem versão própria no motor mas com `minimum_quantity` legado preenchido (dado de
 *      antes desta migração) → publica esse valor como a versão 1 do item (uma única vez).
 * Depois disso, só createMinStockRule decide o valor.
 */
async function getMinStockPolicy(item, transaction, actorUserId, locationId) {
  if (!item || !item.id) {
    throw AppError.badRequest('Item de estoque é obrigatório para resolver a política de estoque mínimo.', 'MIN_STOCK_RULE_VALIDATION');
  }
  const { groupId, companyId } = item;

  let evaluation = await evaluateFor(item, locationId, transaction);
  if (evaluation.decision !== 'APPLY' && ['RULE_NOT_FOUND', 'RULE_NO_ACTIVE_VERSION', 'RULE_NO_MATCHING_SCOPE'].includes(evaluation.reason)) {
    await acquireLock(groupId, companyId, null, transaction);
    const rule = await getOrCreateRule(groupId, companyId, actorUserId, transaction);
    // Re-checa dentro do lock: outra transação concorrente pode ter semeado enquanto esperávamos.
    const openDefault = await findOpenVersionIdsForScope(rule.id, 'GLOBAL', null, transaction);
    if (openDefault.length === 0) {
      await publishPolicyVersion(groupId, companyId, { scopeType: 'GLOBAL', scopeRefId: null }, DEFAULT_POLICY, 'Política padrão (seed automático): sem estoque mínimo.', actorUserId || null, transaction);
    }
    evaluation = await evaluateFor(item, locationId, transaction);
  }
  if (evaluation.decision !== 'APPLY') {
    // Fail-closed real do motor (RULE_CONFLICT, erro de banco etc.) — nunca inventa um mínimo.
    throw AppError.unprocessable(
      `Não foi possível resolver a política de estoque mínimo (${RULE_CODE}) deste item (${evaluation.reason}).`,
      'MIN_STOCK_RULE_NOT_RESOLVED'
    );
  }

  let policy = toPolicy(evaluation, item.id);
  if (policy.source === POLICY_SOURCE_DEFAULT && item.minimumQuantity != null) {
    // Semente única a partir da coluna legada (ver comentário de topo).
    await acquireLock(groupId, companyId, item.id, transaction);
    const rule = await getOrCreateRule(groupId, companyId, actorUserId, transaction);
    const openItem = await findOpenVersionIdsForScope(rule.id, 'OBJECT', item.id, transaction);
    if (openItem.length === 0) {
      await publishPolicyVersion(
        groupId,
        companyId,
        { scopeType: 'OBJECT', scopeRefId: item.id },
        { minimumQuantity: Number(item.minimumQuantity), reorderQuantity: null, byLocation: {} },
        'Migrado de inventory_items.minimum_quantity (seed automático).',
        actorUserId || null,
        transaction
      );
    }
    evaluation = await evaluateFor(item, locationId, transaction);
    if (evaluation.decision !== 'APPLY') {
      throw AppError.unprocessable(
        `Não foi possível resolver a política de estoque mínimo (${RULE_CODE}) deste item (${evaluation.reason}).`,
        'MIN_STOCK_RULE_NOT_RESOLVED'
      );
    }
    policy = toPolicy(evaluation, item.id);
  }
  return policy;
}

/** Limiar efetivo de um local: override do local, senão o mínimo padrão do item; null = sem aviso. */
function resolveMinimumForLocation(policy, locationId) {
  if (!policy) return null;
  if (locationId && policy.byLocation && policy.byLocation[locationId] != null) {
    return Number(policy.byLocation[locationId]);
  }
  return policy.minimumQuantity == null ? null : Number(policy.minimumQuantity);
}

async function getMinStockPolicyByItemId(inventoryItemId, transaction, actorUserId) {
  const item = await InventoryItem.findByPk(inventoryItemId, { transaction });
  if (!item) throw AppError.notFound('Item de estoque não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');
  return getMinStockPolicy(item, transaction, actorUserId);
}

module.exports = {
  RULE_CODE,
  DEFAULT_POLICY,
  createMinStockRule,
  getMinStockPolicy,
  getMinStockPolicyByItemId,
  resolveMinimumForLocation,
};
