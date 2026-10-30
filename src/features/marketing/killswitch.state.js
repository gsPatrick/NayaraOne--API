'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const { withSavepoint } = require('./killswitch.savepoint');
const logger = require('../../utils/logger');
const flagsResolve = require('../core-governance/feature-flags/flags.resolve');
const { GLOBAL_KEY, channelKey, BLOCK_REASONS } = require('./killswitch.constants');
const errors = require('./killswitch.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** A flag do registro (M9-D870) está acionada? Lê pelo flags.resolve, o ponto único de leitura; sem a flag registrada o switch nunca foi acionado. */
async function flagOn(tenant, key, transaction) {
  const out = await flagsResolve.resolve(tenant, key, {}, transaction, { defaultValue: false });
  return out.value === true;
}

async function columnOn(table, id, companyId, transaction) {
  if (!UUID_RE.test(String(id))) return false;
  const rows = await q(`SELECT kill_switch_active FROM marketing.${table} WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL`, transaction, { id, companyId });
  return Boolean(rows[0] && rows[0].kill_switch_active);
}

const asList = (value) => (value === undefined || value === null ? [] : [].concat(value).filter(Boolean).map((c) => String(c).toUpperCase()));

/**
 * Lê o estado do kill switch para uma ação de saída (M9-D425). `channel` (um canal ou uma lista: basta UM ligado), `campaignId` e `automationId` são o que a ação tem; o global
 * vale sempre. Sem cache: cada ação consulta o banco na hora (efeito imediato). FALHA FECHADA: se qualquer leitura der erro, o resultado é `blocked: true` com `unreadable: true`.
 * A leitura roda num savepoint de nome único, para o erro não derrubar a transação de quem chamou. Devolve { blocked, unreadable, active: [{ scope, target? }] }.
 */
async function readKillState(tenant, { channel, campaignId, automationId } = {}, transaction) {
  try {
    return await withSavepoint(transaction, async (tx) => {
      const active = [];
      if (await flagOn(tenant, GLOBAL_KEY, tx)) active.push({ scope: 'GLOBAL' });
      for (const name of asList(channel)) {
        if (await flagOn(tenant, channelKey(name), tx)) active.push({ scope: 'CHANNEL', target: name });
      }
      if (campaignId && await columnOn('campaigns', campaignId, tenant.companyId, tx)) active.push({ scope: 'CAMPAIGN', target: campaignId });
      if (automationId && await columnOn('automation_flows', automationId, tenant.companyId, tx)) active.push({ scope: 'AUTOMATION', target: automationId });
      return { blocked: active.length > 0, unreadable: false, active };
    });
  } catch (err) {
    logger.error({ err: err && err.message }, 'marketing.kill_switch.state_unreadable');
    return { blocked: true, unreadable: true, active: [{ scope: BLOCK_REASONS.UNREADABLE }] };
  }
}

/** Ação de saída automática (mensagem, post, e-mail, publicação): lança 423 MKT_KILL_SWITCH_ACTIVE se QUALQUER escopo aplicável estiver ligado ou o estado não puder ser lido. */
async function assertOutboundAllowed(tenant, scopeCtx, transaction) {
  const state = await readKillState(tenant, scopeCtx, transaction);
  if (state.blocked) throw errors.outboundBlocked({ blockedBy: state.active, unreadable: state.unreadable });
  return state;
}

/** Mesma leitura devolvendo a decisão em vez de lançar (o runner de automação e o disparo de campanha usam: bloqueio não é exceção). */
async function isOutboundBlocked(tenant, scopeCtx, transaction) {
  const state = await readKillState(tenant, scopeCtx, transaction);
  return { blocked: state.blocked, unreadable: state.unreadable, blockedBy: state.active, blockReason: state.blocked ? 'KILL_SWITCH' : null };
}

/** Tenant completo (grupo e empresa) a partir da transação já aberta no contexto da empresa: o gate social só conhece o companyId. */
async function tenantFromContext(companyId, transaction) {
  const rows = await q("SELECT NULLIF(current_setting('app.group_id', true), '') AS group_id", transaction);
  return { groupId: rows[0] ? rows[0].group_id : null, companyId };
}

module.exports = { readKillState, assertOutboundAllowed, isOutboundBlocked, tenantFromContext, flagOn };
