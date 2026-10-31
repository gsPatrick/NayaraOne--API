'use strict';

const { getSetting } = require('../../settings/settings.service');
const logger = require('../../../utils/logger');
const AppError = require('../../../utils/AppError');
const guardService = require('../dlp/guard.service');
const { withOwnTenantTransaction } = require('../dlp/guard.tx');
const scale = require('../../../shared/data-classification/scale');
const classification = require('./classification.service');
const { ensureRegistry } = require('./classification.seed');
const rules = require('./fieldAccess.rules');
const { applyMasking } = require('./fieldAccess.mask');
const audit = require('./fieldAccess.audit');
const settings = require('./fieldAccess.settings');

/**
 * Serviço `fieldAccess` (M9-D915 §3.1): `resolveField(entity, field, actor, context, opts)` devolve `{ visible, maskedValue, rule }` a partir do registro de classificação.
 *  - `entity`: `schema.tabela` do registro; `field`: a coluna (camelCase vira snake_case); `actor`: `{ groupId, companyId, userId, permissions }`.
 *  - `context`: SCREEN, API, COPY, EXPORT, PRINT, AI ou LOG. `opts`: { value, transaction, approved (decisão ALLOW do guard de WITH_APPROVAL), originPermission,
 *    agent, maskText, minClassification (piso de classe de quem chama) }.
 *  - `visible` falso = o campo some (exportação proibida, IA); verdadeiro com `maskedValue` mascarado ou em claro. Campo sem linha no registro vale a classe padrão da
 *    M9-D910 (HIGH, máscara PARTIAL) e gera finding. Erro ao consultar o registro: máscara total (na IA e na exportação, campo omitido), nunca o valor em claro.
 */
const toSnake = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function parseEntity(entity) {
  const parts = String(entity || '').split('.');
  if (parts.length !== 2 || parts.some((part) => !part)) throw new AppError('Entidade inválida: use schema.tabela.', 400, 'GOV_FIELD_ENTITY_INVALID');
  return parts;
}

async function readTexts(tenant, transaction, opts) {
  const read = (key) => getSetting(key, tenant, transaction, settings.FIELD_ACCESS_SETTING_DEFAULTS[key]);
  return {
    maskText: opts.maskText || settings.maskTextOf(await read(settings.MASK_TEXT_KEY)),
    clearAgents: opts.clearAgents || settings.parseAgents(await read(settings.AGENTS_CLEAR_KEY)),
  };
}

/** Piso de classe de quem chama (o catálogo da exportação): a classe sobe, nunca desce; coluna que sobe para RESTRICTED sem sê-lo no registro sai com máscara total. */
function floorOf(spec, opts) {
  if (!opts.minClassification) return spec;
  const classification = scale.highest([spec.classification, opts.minClassification]);
  const raised = classification === 'RESTRICTED' && spec.classification !== 'RESTRICTED';
  return { ...spec, classification, masking: raised ? 'FULL' : spec.masking };
}

/** Consulta o guard de DLP uma vez por (ação, classe, ai_allowed); devolve true quando libera. Erro do guard: false (fail closed). */
async function guardAllows(tenant, actor, ref, action, spec, cache) {
  const key = `${action}:${spec.classification}:${spec.aiAllowed}`;
  if (!cache.has(key)) {
    cache.set(key, guardService.decide({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, {
      action, resourceType: ref, minClassification: spec.classification, aiAllowed: spec.aiAllowed, permissions: actor.permissions || [], actorUserId: tenant.userId,
    }).then((verdict) => verdict.decision === 'ALLOW', (error) => { logger.error({ err: error && error.message, action }, 'fieldAccess: falha ao consultar o guard de DLP'); return false; }));
  }
  return cache.get(key);
}

function protectedItem(field, value, ctx, reason) {
  const omitted = ctx.context === 'AI' || ctx.context === 'EXPORT';
  const rule = { classification: null, masking: 'FULL', exportability: null, aiAllowed: null, outcome: omitted ? 'OMITTED' : 'MASKED', reason, isDefault: false, finding: null };
  return { field, visible: !omitted, maskedValue: omitted ? undefined : applyMasking(value === undefined ? '' : value, 'FULL', { maskText: ctx.maskText }), rule };
}

function present(field, value, spec, verdict, ctx) {
  const masking = rules.effectiveMasking(spec, ctx.context);
  const rule = {
    classification: spec.classification, masking, maskPattern: spec.maskPattern || null, maskText: ctx.maskText, exportability: spec.exportability, aiAllowed: spec.aiAllowed,
    outcome: verdict.outcome, reason: verdict.reason, isDefault: Boolean(spec.isDefault), finding: spec.finding || null,
  };
  if (verdict.outcome === 'OMITTED') return { field, visible: false, maskedValue: undefined, rule };
  const column = toSnake(field);
  const maskedValue = verdict.outcome === 'CLEAR' ? value : applyMasking(value, masking, { field: column, maskPattern: spec.maskPattern, companyId: ctx.companyId, maskText: ctx.maskText });
  return { field, visible: true, maskedValue, rule };
}

const ensured = new Set();
/** O registro da empresa nasce no primeiro uso (M9-D910); sem ele toda coluna cairia na classe padrão. Conferido uma vez por empresa e processo. */
async function ensureOnce(tenant, transaction) {
  if (ensured.has(tenant.companyId)) return;
  await ensureRegistry(tenant, transaction);
  ensured.add(tenant.companyId);
}
const forgetEnsured = () => ensured.clear();

async function resolveInside(entity, items, actor, context, opts, transaction) {
  const [schema, table] = parseEntity(entity);
  const tenant = { groupId: actor.groupId, companyId: actor.companyId, userId: actor.userId || null };
  try { await ensureOnce(tenant, transaction); } catch (error) { logger.error({ err: error && error.message }, 'fieldAccess: não foi possível garantir o registro; vale a classe padrão e a falha fechada'); }
  const texts = await readTexts(tenant, transaction, opts);
  const ctx = { context, companyId: tenant.companyId, maskText: texts.maskText };
  const guardCache = new Map();
  const out = [];
  const cleared = [];
  for (const item of items) {
    const column = toSnake(item.field);
    const ref = `${schema}.${table}.${column}`;
    try {
      const spec = floorOf(await classification.resolveColumn(tenant, schema, table, column, transaction), { minClassification: item.minClassification || opts.minClassification });
      let verdict = rules.decide(spec, actor, context, { ...opts, clearAgents: texts.clearAgents });
      if (verdict.guard && !(await guardAllows(tenant, actor, ref, verdict.guard, spec, guardCache))) {
        verdict = context === 'AI' ? { outcome: 'OMITTED', reason: 'AI_POLICY_DENY' } : { outcome: 'MASKED', reason: 'POLICY_DENY' };
      }
      if (verdict.outcome === 'CLEAR' && rules.isSensitive(spec.classification) && context !== 'AI') cleared.push(ref);
      out.push({ ...present(item.field, item.value, spec, verdict, ctx), ref });
    } catch (error) {
      logger.error({ err: error && error.message, ref, context }, 'fieldAccess: falha ao consultar o registro; campo protegido por fail closed');
      await audit.recordFailClosed(tenant, ref, context, (error && error.code) || 'ERROR', transaction);
      out.push({ ...protectedItem(item.field, item.value, ctx, 'FAIL_CLOSED'), ref });
    }
  }
  await audit.recordClearRead(tenant, cleared, context, transaction);
  return out;
}

/** Vários campos da mesma entidade de uma vez (uma só leitura de parâmetros, um só guard por classe, uma só auditoria). `items`: [{ field, value }]. */
async function resolveFields(entity, items, actor, context, opts = {}) {
  const upper = String(context || '').toUpperCase();
  if (!rules.CONTEXTS.includes(upper)) throw new AppError('Contexto de acesso inválido.', 400, 'GOV_FIELD_CONTEXT_INVALID', { allowed: rules.CONTEXTS });
  if (!actor || !actor.companyId || !actor.groupId) throw new AppError('Empresa do ator ausente.', 400, 'GOV_FIELD_ACTOR_INVALID');
  if (opts.transaction) return resolveInside(entity, items, actor, upper, opts, opts.transaction);
  return withOwnTenantTransaction(actor, actor.userId, (transaction) => resolveInside(entity, items, actor, upper, opts, transaction));
}

async function resolveField(entity, field, actor, context, opts = {}) {
  const [only] = await resolveFields(entity, [{ field, value: opts.value }], actor, context, opts);
  const { ref, ...rest } = only;
  return rest;
}

module.exports = { resolveField, resolveFields, toSnake, forgetEnsured };
