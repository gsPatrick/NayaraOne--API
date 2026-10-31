'use strict';

/**
 * ContextBuilder da NAY (M9-D027). Ordem fixa: (1) aiAccess.assertAllowed (M9-D915) retira os campos que a IA não pode ver;
 * (2) nada de outra empresa/grupo entra (defesa em profundidade além da RLS); (3) portão de classificação (RESTRICTED só com as
 * quatro condições); (4) promptBuilder (lista branca de campos, pseudonimização, redaction). A decisão é auditada e registrada em
 * log sem o conteúdo. O guarda de campos é injetado (`deps.aiAccess`): sem ele o contexto NÃO é montado (falha fechada).
 */
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { safeLogger: logger } = require('../audit/safeLogger');
const { getSetting } = require('../../settings/settings.service');
const { applyClassificationGate } = require('./classificationGate');
const { getTaskType } = require('./taskTypes');
const { buildPrompt } = require('./promptBuilder');
const { createPiiRedactor } = require('./piiRedactor');
const { accessGuardRequired, contextInvalid } = require('./privacy.errors');
const { PRIVACY_PSEUDONYMIZE_KEY, PRIVACY_SETTING_DEFAULTS } = require('./privacy.settings');

function resolveAiAccess(deps) {
  const injected = deps && deps.aiAccess;
  if (injected && typeof injected.assertAllowed === 'function') return injected;
  throw accessGuardRequired();
}

const refOf = (source, name) => (source.fieldRefs && source.fieldRefs[name]) || `${source.key}.${name}`;

/** Passo 1: aiAccess.assertAllowed. Devolve as fontes só com os campos permitidos e a lista dos retirados (referências, nunca valores). */
async function applyFieldAccess(aiAccess, sources, agentContext, runtime) {
  const fields = sources.flatMap((s) => Object.keys(s.fields || {}).map((name) => ({ ref: refOf(s, name), sourceId: s.id, name })));
  // O terceiro argumento (empresa, usuário e transação do pedido) é do guarda real (M9-D915); o segundo continua sendo só o contexto do agente (DI-D027-3).
  const verdict = (await aiAccess.assertAllowed(fields, agentContext, runtime)) || {};
  const masks = verdict.masks || {};
  const allowedRefs = new Set(Array.isArray(verdict) ? verdict.map((f) => f.ref || f) : (verdict.allowedFields || []).map((f) => f.ref || f));
  const removed = [];
  const kept = sources.map((s) => {
    const next = {};
    for (const [name, value] of Object.entries(s.fields || {})) {
      const ref = refOf(s, name);
      // Campo liberado com máscara no registro (ai_allowed e masking) entra mascarado: o guarda devolve a função de máscara de cada referência.
      if (allowedRefs.has(ref)) next[name] = typeof masks[ref] === 'function' ? masks[ref](value) : value; else removed.push(ref);
    }
    return { ...s, fields: next };
  });
  return { kept, removed };
}

const sameTenant = (ctx, s) => s.companyId === ctx.companyId && s.groupId === ctx.groupId;

function arrangeData(sources) {
  const data = {};
  for (const s of sources) {
    if (data[s.key] === undefined) data[s.key] = s.fields;
    else data[s.key] = [].concat(data[s.key], [s.fields]);
  }
  return data;
}

async function recordDecision(ctx, input, summary, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId || null,
    action: 'ai.context.privacy_decision',
    entityType: 'AiRun',
    entityId: input.runId || null,
    beforeJson: { registro: 'inexistente' },
    afterJson: summary,
    reason: 'Decisão de privacidade do contexto da NAY (sem o conteúdo).',
  }, transaction);
  logger.info({ runId: input.runId || null, taskType: input.taskType, ...summary.contagem }, 'ai.context.privacy_decision');
}

/**
 * buildContext(ctx, input, transaction, deps) — input: { runId, taskType, instruction, sources: [{ id, key, classification, groupId,
 * companyId, fields, fieldRefs }], provider, purpose, agentContext, knownNames }. Devolve { messages, notices, decisions, rehydrate }.
 */
async function buildContext(ctx, input, transaction, deps = {}) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw contextInvalid('Contexto de empresa ausente.');
  const aiAccess = resolveAiAccess(deps);
  const task = getTaskType(input.taskType);
  const sources = Array.isArray(input.sources) ? input.sources : [];
  if (sources.some((s) => !s || typeof s.key !== 'string' || !s.key)) throw contextInvalid('Toda fonte do contexto precisa de uma chave.');

  const { kept, removed } = await applyFieldAccess(aiAccess, sources, input.agentContext, { ctx, transaction });
  const ownTenant = kept.filter((s) => sameTenant(ctx, s));
  const gate = applyClassificationGate(ownTenant, { task, actor: ctx, provider: input.provider, purpose: input.purpose });
  const pseudonymizeNames = (await getSetting(PRIVACY_PSEUDONYMIZE_KEY, ctx, transaction, PRIVACY_SETTING_DEFAULTS[PRIVACY_PSEUDONYMIZE_KEY])) !== false;

  const redactor = createPiiRedactor();
  const prompt = buildPrompt({
    taskType: input.taskType, instruction: input.instruction, data: arrangeData(gate.allowed), provider: input.provider,
    pseudonymizeNames, knownNames: input.knownNames || [], redactor,
  });

  const summary = {
    decisoes: gate.decisions,
    camposRetirados: removed,
    fontesDeOutraEmpresaDescartadas: kept.length - ownTenant.length,
    contagem: { fontes: sources.length, omitidas: gate.omitted.length, camposRetirados: removed.length, descartadas: kept.length - ownTenant.length },
  };
  await recordDecision(ctx, input, summary, transaction);
  return { messages: prompt.messages, notices: gate.notices, decisions: gate.decisions, pseudonymized: prompt.pseudonymized, rehydrate: (texto) => redactor.rehydrate(texto) };
}

module.exports = { buildContext };
