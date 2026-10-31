'use strict';

const AppError = require('../../../utils/AppError');
const { registrarAuditoria, registrarTentativaBloqueada } = require('../../../engines/audit/auditLog.service');
const { withOwnTenantTransaction } = require('../dlp/guard.tx');
const fieldAccess = require('./fieldAccess.service');
const { applyMasking } = require('./fieldAccess.mask');

/**
 * Guarda de campos da IA (M9-D915 §3.4): `assertAllowed(fields, agentContext)`, usado pelo ContextBuilder da NAY (M9-D027), pelo RAG e pelas tools.
 *  - `fields`: [{ ref, sourceId, name }]; `ref` = `schema.tabela.coluna` (sem valor). `agentContext`: { agent ou agentCode (código do agente), strict }; o ContextBuilder passa a empresa,
 *    o usuário e a transação do pedido no terceiro argumento (`runtime: { ctx, transaction }`), e quem chama sem ele pode pôr groupId, companyId, userId, permissions e transaction no próprio agentContext.
 *  - Devolve { allowedFields, removedFields (referências), removed (referência e motivo), masks }: `masks[ref](valor)` aplica a máscara do registro ao valor do campo
 *    liberado (campo com ai_allowed e máscara entra mascarado, salvo agente da lista fechada `governanca.ia.agentes_claro` em campo LOW ou MEDIUM).
 *  - Campo com ai_allowed falso, RESTRICTED, política de AI do DLP que nega, referência inválida ou erro no registro: retirado (fail closed). Cada decisão é auditada em
 *    `governance.ai_access` (campos permitidos, retirados e agente). Com `strict`, qualquer retirada vira bloqueio (403 GOV_AI_FIELD_FORBIDDEN) auditado como tentativa.
 */
const REF = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/;
const AUDIT_ACTION = 'governance.ai_access';

function groupByEntity(fields) {
  const groups = new Map();
  const invalid = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    const match = REF.exec(field && field.ref ? String(field.ref) : '');
    if (!match) { invalid.push(field && field.ref ? String(field.ref) : String((field && field.name) || '?')); continue; }
    const key = `${match[1]}.${match[2]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ref: field.ref, field: match[3] });
  }
  return { groups, invalid };
}

async function evaluate(fields, context, transaction) {
  const { groups, invalid } = groupByEntity(fields);
  const allowedFields = [];
  const removed = invalid.map((ref) => ({ ref, reason: 'REF_INVALID' }));
  const masks = {};
  const actor = { groupId: context.groupId, companyId: context.companyId, userId: context.userId || null, permissions: context.permissions || [] };
  for (const [entity, items] of groups) {
    const decided = await fieldAccess.resolveFields(entity, items.map((item) => ({ field: item.field })), actor, 'AI', { transaction, agent: context.agent || context.agentCode });
    decided.forEach((result, index) => {
      const { ref } = items[index];
      if (!result.visible) { removed.push({ ref, reason: result.rule.reason }); return; }
      allowedFields.push(ref);
      const { rule } = result;
      masks[ref] = (value) => (rule.outcome === 'CLEAR' ? value : applyMasking(value, rule.masking, { field: items[index].field, maskPattern: rule.maskPattern, companyId: context.companyId, maskText: rule.maskText }));
    });
  }
  return { allowedFields, removed, masks };
}

async function auditDecision(context, verdict, transaction) {
  const base = {
    groupId: context.groupId, companyId: context.companyId, actorUserId: context.userId || null, action: AUDIT_ACTION, entityType: 'AiAccess', entityId: null,
  };
  const afterJson = { agent: context.agent || context.agentCode || null, allowedFields: verdict.allowedFields, removedFields: verdict.removed };
  if (context.strict && verdict.removed.length) {
    await registrarTentativaBloqueada({ ...base, beforeJson: afterJson, reason: 'Tentativa de enviar à IA campo que o registro de classificação proíbe.' }, transaction);
  } else {
    await registrarAuditoria({ ...base, beforeJson: null, afterJson, reason: `Campos liberados à IA: ${verdict.allowedFields.length}; retirados: ${verdict.removed.length}.` }, transaction);
  }
}

async function run(fields, context, transaction) {
  const verdict = await evaluate(fields, context, transaction);
  await auditDecision(context, verdict, transaction);
  return verdict;
}

async function assertAllowed(fields, agentContext, runtime = {}) {
  const ctx = runtime.ctx || {};
  const context = {
    groupId: ctx.groupId, companyId: ctx.companyId, userId: ctx.userId, permissions: ctx.permissions, transaction: runtime.transaction, ...(agentContext || {}),
  };
  if (!context.groupId || !context.companyId) throw new AppError('Empresa do agente ausente: o guarda de campos da IA não decide sem ela.', 400, 'GOV_AI_CONTEXT_INVALID');
  const verdict = context.transaction
    ? await run(fields, context, context.transaction)
    : await withOwnTenantTransaction(context, context.userId, (transaction) => run(fields, context, transaction));
  if (context.strict && verdict.removed.length) {
    throw new AppError('Este dado não pode ser enviado à IA.', 403, 'GOV_AI_FIELD_FORBIDDEN', { fields: verdict.removed.map((item) => item.ref) });
  }
  return { allowedFields: verdict.allowedFields, removedFields: verdict.removed.map((item) => item.ref), removed: verdict.removed, masks: verdict.masks };
}

module.exports = { assertAllowed, AUDIT_ACTION };
