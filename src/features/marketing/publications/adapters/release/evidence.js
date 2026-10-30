'use strict';

const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const { registrarAuditoria } = require('../../../../../engines/audit/auditLog.service');
const { mktForbidden } = require('../../../marketing.errors');
const { ADAPTER_VERSION } = require('../channels');
const { invalid, normalizeChannel } = require('../channel.errors');
const { SCENARIOS } = require('../sandbox/sandbox.scenarios');

/**
 * Evidências de homologação do canal (M9-D430 3.6), sem tabela nova: cada uma é uma entrada da trilha de auditoria (motor src/engines/audit), da
 * empresa e do canal, escrita só por estes serviços e lida por releaseChannel. São três: política de consentimento aprovada, adapter homologado
 * (na versão vigente do contrato) e failure drill executado (M9-D442 chama recordChannelDrill com os cenários que rodou). O contrato roda ao vivo.
 */
const PERMISSION = 'marketing:killswitch:manage';
const AUDIT_ENTITY = 'marketing.channel';
const ACTIONS = Object.freeze({
  CONSENT_POLICY: 'marketing.channel.consent_policy_approved',
  ADAPTER_HOMOLOGATION: 'marketing.channel.adapter_homologated',
  FAILURE_DRILL: 'marketing.channel.drill_executed',
});

/** UUID estável por empresa e canal (a trilha de auditoria guarda o id da entidade como uuid). */
function channelEntityId(companyId, channel) {
  const h = crypto.createHash('sha256').update(`${AUDIT_ENTITY}|${companyId}|${channel}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function assertManage(permissions) {
  if (!Array.isArray(permissions) || !permissions.includes(PERMISSION)) throw mktForbidden({ required: PERMISSION });
}

function assertReason(reason) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw invalid('Informe o motivo.', { campo: 'reason' });
  return why;
}

function audit({ tenant, actor }, { action, channel, before = null, after, reason }, transaction) {
  return registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor || null, action, entityType: AUDIT_ENTITY, entityId: channelEntityId(tenant.companyId, channel), beforeJson: before, afterJson: after, reason,
  }, transaction);
}

/** Política de consentimento do canal aprovada (quem aprova é a Diretoria, com motivo). */
async function approveConsentPolicy(channelName, { reason }, ctx, transaction) {
  assertManage(ctx.permissions);
  const channel = normalizeChannel(channelName);
  const why = assertReason(reason);
  await audit(ctx, { action: ACTIONS.CONSENT_POLICY, channel, after: { channel, approved: true }, reason: why }, transaction);
  return { channel, approved: true };
}

/** Homologação do adapter do canal na versão vigente do contrato (depois de rodar o contrato em LAB). */
async function homologateAdapter(channelName, { reason }, ctx, transaction) {
  assertManage(ctx.permissions);
  const channel = normalizeChannel(channelName);
  const why = assertReason(reason);
  await audit(ctx, { action: ACTIONS.ADAPTER_HOMOLOGATION, channel, after: { channel, homologated: true, adapterVersion: ADAPTER_VERSION }, reason: why }, transaction);
  return { channel, homologated: true, adapterVersion: ADAPTER_VERSION };
}

/** Registro do failure drill do canal: { ok, scenarios } com os cenários que rodaram. Só vale se rodou TODOS e o Marketing se comportou (ok). */
async function recordChannelDrill(channelName, { ok, scenarios }, ctx, transaction) {
  assertManage(ctx.permissions);
  const channel = normalizeChannel(channelName);
  if (typeof ok !== 'boolean' || !Array.isArray(scenarios)) throw invalid('Informe o resultado do failure drill e os cenários executados.', { campos: ['ok', 'scenarios'] });
  await audit(ctx, { action: ACTIONS.FAILURE_DRILL, channel, after: { channel, ok, scenarios, adapterVersion: ADAPTER_VERSION }, reason: 'Failure drill do canal executado.' }, transaction);
  return { channel, ok, scenarios };
}

/** A evidência mais recente da empresa e do canal para a ação, ou null. */
async function latestEvidence(action, channel, tenant, transaction) {
  const [row] = await sequelize.query(
    `SELECT after_json, occurred_at, user_id FROM audit.audit_log
      WHERE company_id = :companyId AND entity_type = :entity AND entity_id = :entityId AND action = :action
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    { replacements: { companyId: tenant.companyId, entity: AUDIT_ENTITY, entityId: channelEntityId(tenant.companyId, channel), action }, type: QueryTypes.SELECT, transaction },
  );
  return row ? { ...row.after_json, at: row.occurred_at, by: row.user_id } : null;
}

const VALID = {
  CONSENT_POLICY: (e) => e.approved === true,
  ADAPTER_HOMOLOGATION: (e) => e.homologated === true && e.adapterVersion === ADAPTER_VERSION,
  FAILURE_DRILL: (e) => e.ok === true && e.adapterVersion === ADAPTER_VERSION && SCENARIOS.every((s) => Array.isArray(e.scenarios) && e.scenarios.includes(s)),
};

/** Estado das três evidências: [{ item, ok, at, by }]. */
async function readEvidence(channel, tenant, transaction) {
  const out = [];
  for (const item of ['FAILURE_DRILL', 'CONSENT_POLICY', 'ADAPTER_HOMOLOGATION']) {
    const e = await latestEvidence(ACTIONS[item], channel, tenant, transaction);
    out.push({ item, ok: Boolean(e && VALID[item](e)), at: e ? e.at : null, by: e ? e.by : null });
  }
  return out;
}

module.exports = { PERMISSION, AUDIT_ENTITY, ACTIONS, channelEntityId, assertManage, assertReason, audit, approveConsentPolicy, homologateAdapter, recordChannelDrill, readEvidence };
