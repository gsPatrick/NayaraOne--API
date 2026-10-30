'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { isOutboundBlocked } = require('../../killswitch.state');
const { evaluateValidity } = require('../definition.validity');
const { evaluateAutomationPolicy } = require('../policy');
const { subjectIsInCompany } = require('./runner.subject');
const ports = require('./runner.ports');
const { resolveVersionCap } = require('../frequency.cap');
const { SEND, SEND_BLOCK_REASONS, MESSAGE_PURPOSE_DEFAULT } = require('./runner.constants');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const CONTACT_TYPES = Object.freeze({ WHATSAPP: ['WHATSAPP', 'PHONE'], EMAIL: ['EMAIL'] });

/** Canal da ação de envio: o informado, ou (`AUTO`) o primeiro da ordem do parâmetro em que a pessoa tem contato; nenhum = null (NO_CONTACT_CHANNEL). */
async function resolveChannel(def, subject, ctx) {
  const wanted = String(def.channel || '').toUpperCase();
  if (wanted && wanted !== 'AUTO' && !ports.hasChannelResolver(wanted)) return wanted;
  if (!subject) return null;
  const preferred = wanted && wanted !== 'AUTO' ? await ports.channelResolved(wanted, { def, subject, event: ctx.event, tenant: ctx.tenant, transaction: ctx.transaction }) : null; // canal nomeado (ex.: o de origem do lead)
  if (preferred) return String(preferred).toUpperCase();
  for (const channel of ctx.params.autoChannels) {
    const rows = await q('SELECT 1 AS ok FROM people.person_contacts WHERE company_id = :c AND person_id = :p AND contact_type IN (:types) AND deleted_at IS NULL LIMIT 1',
      { c: ctx.tenant.companyId, p: subject.id, types: CONTACT_TYPES[channel] }, ctx.transaction);
    if (rows.length) return channel;
  }
  return null;
}

const isOfficial = async (templateId, ctx) => Boolean(templateId) && (await q('SELECT official_template_ref FROM marketing.templates WHERE id = :id', { id: templateId }, ctx.transaction))[0]?.official_template_ref;
const purposeOf = (def) => String(def.purpose || MESSAGE_PURPOSE_DEFAULT).toUpperCase();
const expired = (def, now) => Boolean(def.expiresAt) && now.getTime() > new Date(def.expiresAt).getTime();

async function campaignRunning(version, ctx) {
  const id = version.triggerConfig && version.triggerConfig.campaignId;
  if (!id) return true;
  const rows = await q('SELECT status FROM marketing.campaigns WHERE id = :id AND company_id = :c AND deleted_at IS NULL', { id, c: ctx.tenant.companyId }, ctx.transaction);
  return rows.length > 0 && rows[0].status === 'RUNNING';
}

/**
 * Passo 3 para UMA ação de envio, na ordem do livro: sem canal (NO_CONTACT_CHANNEL), prazo vencido (EXPIRED) e o canSend (opt-out, quiet hours, cap, consent), que
 * aplica a ordem e o cap uma única vez. Horário de silêncio não bloqueia: devolve `delay` com o próximo horário livre. Reusado pelo executor das ações adiadas.
 */
async function decideSend(def, ctx, version, subject, now = ctx.now) {
  const channel = await resolveChannel(def, subject, ctx);
  const base = { channel, purpose: purposeOf(def) };
  if (!channel) return { ...base, kind: 'blocked', reason: 'NO_CONTACT_CHANNEL' };
  if (expired(def, now)) return { ...base, kind: 'blocked', reason: 'EXPIRED' };
  if (!subject) return { ...base, kind: 'blocked', reason: 'NO_ADDRESS' };
  const decision = await ports.canSend(subject.id, channel, base.purpose, now, { tenant: ctx.tenant, transaction: ctx.transaction, capDaVersao: await resolveVersionCap(version.frequencyCap, ctx.tenant, ctx.transaction), officialTemplate: Boolean(await isOfficial(def.templateId, ctx)) });
  if (decision.allowed) return { ...base, kind: 'allowed' };
  if (decision.reason === 'QUIET_HOURS') return { ...base, kind: 'delay', reason: 'QUIET_HOURS', dueAt: decision.nextEligibleAt };
  return { ...base, kind: 'blocked', reason: decision.reason, nextEligibleAt: decision.nextEligibleAt || null };
}

const skipped = (step, name, extra = {}) => ({ step, name, skipped: true, ...extra });

/**
 * Passos 2 a 5 do runner. Devolve { applicability, runBlock, sends } e empilha o rastro (`ctx.trace`). Aplicabilidade (validade, empresa, campanha, condições) cancela tudo;
 * bloqueio de envio (kill switch, canSend, cooldown) só tira as mensagens; os passos 4 e 5 só rodam se o 3 permitiu.
 */
async function decide(ctx, cand) {
  const { flow, version } = cand;
  const { subject, event } = ctx;
  const out = { applicability: null, runBlock: null, sends: {} };

  const validity = evaluateValidity(version, ctx.now);
  const sameCompany = await subjectIsInCompany(subject, ctx.tenant, event.payload, ctx.transaction);
  const running = await campaignRunning(version, ctx);
  out.applicability = (!validity.ok && validity.reason) || (!sameCompany && 'CROSS_COMPANY') || (!running && 'CAMPAIGN_NOT_RUNNING') || null;
  ctx.trace.push({ step: 2, name: 'RESOLVE_VERSION', flowId: flow.id, versionNo: version.versionNo, validity: validity.ok ? 'OK' : validity.reason, sameCompany, campaignRunning: running, blocked: out.applicability });
  if (out.applicability) {
    ctx.trace.push(skipped(3, 'SUPPRESSION_CONSENT', { reason: out.applicability }), skipped(4, 'COOLDOWN', { reason: out.applicability }), skipped(5, 'CONDITIONS', { reason: out.applicability }));
    return out;
  }

  const forced = version.triggerConfig && version.triggerConfig.blockWith;
  if (SEND_BLOCK_REASONS.includes(forced)) { // automação cujo desfecho é o próprio bloqueio de envio (ex.: série de lembretes expirada): as ações internas executam e nenhuma mensagem sai
    out.runBlock = forced;
    ctx.trace.push({ step: 3, name: 'SUPPRESSION_CONSENT', forcedBy: 'trigger_config.blockWith', reason: forced }, skipped(4, 'COOLDOWN', { reason: forced }), skipped(5, 'CONDITIONS', { reason: forced }));
    return out;
  }

  const sendDefs = version.actions.map((def, index) => ({ def, index })).filter((x) => x.def.actionType === SEND);
  const resolved = {};
  for (const { def, index } of sendDefs) resolved[index] = await resolveChannel(def, subject, ctx);
  const kill = await isOutboundBlocked(ctx.tenant, { channel: Object.values(resolved).filter(Boolean), campaignId: version.triggerConfig && version.triggerConfig.campaignId, automationId: flow.id }, ctx.transaction);
  const step3 = { step: 3, name: 'SUPPRESSION_CONSENT', killSwitch: { blocked: kill.blocked, unreadable: kill.unreadable, by: kill.blockedBy || [] }, sends: [] };
  for (const { def, index } of sendDefs) {
    if (def.cadence) { // mensagem de cadência: kill switch e canSend valem na hora do envio (executor das ações adiadas), nunca na criação da agenda
      out.sends[index] = { kind: 'deferred', channel: resolved[index], purpose: purposeOf(def) };
      step3.sends.push({ index, channel: resolved[index], purpose: purposeOf(def), allowed: null, decision: 'deferred', reason: null, nextEligibleAt: null });
      continue;
    }
    const decision = kill.blocked ? { kind: 'blocked', reason: 'KILL_SWITCH', channel: resolved[index], purpose: purposeOf(def) } : await decideSend(def, ctx, version, subject);
    out.sends[index] = decision;
    step3.sends.push({ index, channel: decision.channel, purpose: decision.purpose, allowed: decision.kind === 'allowed', decision: decision.kind, reason: decision.reason || null, nextEligibleAt: decision.nextEligibleAt || decision.dueAt || null });
  }
  out.runBlock = (Object.values(out.sends).find((s) => s.kind === 'blocked') || {}).reason || null;
  ctx.trace.push(step3);
  if (out.runBlock) {
    ctx.trace.push(skipped(4, 'COOLDOWN', { reason: out.runBlock, frequencyCap: { evaluatedBy: 'canSend', recalculated: false } }), skipped(5, 'CONDITIONS', { reason: out.runBlock }));
    return out;
  }

  const firstChannel = (Object.values(out.sends)[0] || {}).channel || null;
  const policy = await evaluateAutomationPolicy({ version: { flowId: flow.id, conditions: version.conditions, cooldown: version.cooldown }, subject: subject || { type: 'NONE', id: null }, channel: firstChannel, now: ctx.now }, ctx.tenant, ctx.transaction);
  const cooldownBlocked = !policy.allowed && policy.reason === 'COOLDOWN';
  ctx.trace.push({ step: 4, name: 'COOLDOWN', blocked: cooldownBlocked, nextEligibleAt: policy.nextEligibleAt || null, frequencyCap: { evaluatedBy: 'canSend', recalculated: false } });
  ctx.trace.push({ step: 5, name: 'CONDITIONS', evaluatedBy: 'evaluateAutomationPolicy', blocked: !policy.allowed && !cooldownBlocked, reason: policy.allowed ? null : policy.reason, conditions: policy.trace || [] });
  if (!policy.allowed) {
    if (SEND_BLOCK_REASONS.includes(policy.reason)) out.runBlock = policy.reason;
    else out.applicability = policy.reason;
  }
  return out;
}

module.exports = { decide, decideSend, resolveChannel };
