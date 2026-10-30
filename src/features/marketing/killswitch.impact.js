'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const flagsRepo = require('../core-governance/feature-flags/flags.repository');
const { registerImpactResolver } = require('../core-governance/feature-flags/kill-switch/killSwitch.impact');
const { ACTIONS: DESTRUCTIVE } = require('../core-governance/feature-flags/kill-switch/killSwitch.constants');
const { SCOPES, GLOBAL_KEY, channelKey } = require('./killswitch.constants');
const { impactCounts } = require('./killswitch.impact.count');
const errors = require('./killswitch.errors');
const { CHANNELS } = require('./publications/adapters/channels');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = '/marketing/kill-switch';
const TABLES = { [SCOPES.CAMPAIGN]: 'campaigns', [SCOPES.AUTOMATION]: 'automation_flows' };

const isMarketingCall = (ctx) => Boolean(ctx.req && String(ctx.req.originalUrl || ctx.req.url || '').includes(ROUTE));

/** Alvo do corpo (escopo e alvo) sem exigir motivo: a simulação de impacto só precisa de saber o que seria desligado. */
function targetOf(body) {
  const b = body && typeof body === 'object' ? body : {};
  const scope = typeof b.scope === 'string' ? b.scope.trim().toUpperCase() : '';
  if (!SCOPES[scope]) throw errors.inputInvalid({ field: 'scope', allowed: Object.keys(SCOPES) });
  if (scope === SCOPES.GLOBAL) return { scope, targetId: null };
  if (typeof b.targetId !== 'string' || !b.targetId.trim()) throw errors.inputInvalid({ field: 'targetId' });
  const targetId = scope === SCOPES.CHANNEL ? b.targetId.trim().toUpperCase() : b.targetId.trim().toLowerCase();
  if (scope === SCOPES.CHANNEL ? !CHANNELS.includes(targetId) : !UUID_RE.test(targetId)) throw errors.targetNotFound({ scope, targetId });
  return { scope, targetId };
}

/** Estado atual e rótulo do alvo (o código que se digita na reativação). Alvo inexistente devolve null. */
async function describeTarget(tenant, { scope, targetId }, transaction) {
  if (scope === SCOPES.GLOBAL || scope === SCOPES.CHANNEL) {
    const key = scope === SCOPES.GLOBAL ? GLOBAL_KEY : channelKey(targetId);
    const row = await flagsRepo.findBySlot(tenant, 'FLAG', key, 'COMPANY', tenant.companyId, transaction);
    return { active: Boolean(row && row.value === true), code: key, label: key };
  }
  const rows = await sequelize.query(
    `SELECT code, name, kill_switch_active FROM marketing.${TABLES[scope]} WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL`,
    { type: QueryTypes.SELECT, transaction, replacements: { id: targetId, companyId: tenant.companyId } }
  );
  return rows[0] ? { active: rows[0].kill_switch_active === true, code: rows[0].code, label: rows[0].name } : null;
}

/** Identificador do recurso para o impactToken: escopo e alvo (o mesmo na simulação e na ação, porque o token é preso a ele). */
function resourceIdOf(req) {
  const b = (req && req.body) || {};
  const scope = typeof b.scope === 'string' ? b.scope.trim().toUpperCase() : '';
  const target = typeof b.targetId === 'string' ? b.targetId.trim().toLowerCase() : '';
  return scope ? `${scope}:${target}` : null;
}

const EFFECT = {
  [DESTRUCTIVE.activate]: 'deixa de enviar ou publicar até a reativação (nada é apagado)',
  [DESTRUCTIVE.restore]: 'volta a ser processado no próximo ciclo (nada foi descartado)',
};

/**
 * Resolvedor de impacto das linhas 14 do inventário (M9-D852) para POST /marketing/kill-switch: acionar (nível 2, sem MFA) e reativar (nível 3, com MFA, código digitado e
 * justificativa). Reconhece a chamada pela rota e por `active` booleano no corpo. Na ação (`!preview`) só pede confirmação quando é a transição de fato; o resto segue sem guarda.
 */
async function marketingImpact(action, ctx) {
  if (!isMarketingCall(ctx)) return null;
  const { body, tenant, transaction, preview } = ctx;
  const target = targetOf(body);
  const info = await describeTarget(tenant, target, transaction);
  if (!info) {
    if (preview) throw errors.targetNotFound(target);
    return { skip: true };
  }
  const wantsActivate = action === DESTRUCTIVE.activate;
  if (!preview && !(wantsActivate ? body.active === true && !info.active : body.active === false && info.active)) return { skip: true };
  const counts = await impactCounts(tenant, target, transaction);
  const blockers = !wantsActivate && !info.active ? ['Este kill switch não está acionado.'] : [];
  return {
    code: info.code,
    label: info.label,
    impact: {
      counts: { ...counts, alreadyTriggered: info.active ? 1 : 0 },
      totalAmountCents: 0,
      blockers,
      items: [{ type: 'KILL_SWITCH', scope: target.scope, target: target.targetId, label: info.label, effect: EFFECT[action] }],
    },
  };
}

registerImpactResolver(marketingImpact);

module.exports = { marketingImpact, resourceIdOf, targetOf, describeTarget };
