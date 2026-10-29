'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { resolveConsent } = require('../../people/personConsents.service');
const { cadence, policy } = require('../automations'); // só pelo index da área (m9d402: nenhuma área importa outra por caminho interno)
const { classifyPurpose } = require('./purposes');
const { acquireSendLocks } = require('./sendLock');
const { resolvePersonAddresses } = require('./address');
const { findActiveSuppression } = require('./suppression.repository');
const { readServiceWindowHours, readOfficialTemplateChannels } = require('./suppression.settings');

const { checkQuietHours } = cadence;
const { evaluateFrequencyForSend, reserveSendAction, blocked, HOUR_MS } = policy;
const ALL_PURPOSES = 'ALL';

/** Consentimento vigente: o mais recente entre o da finalidade e o geral (ALL) no canal. */
async function effectiveConsent(personId, channel, purpose, transaction) {
  const [specific, general] = await Promise.all([resolveConsent(personId, channel, purpose, transaction), resolveConsent(personId, channel, ALL_PURPOSES, transaction)]);
  if (!specific || !general) return specific || general || null;
  return new Date(general.recordedAt).getTime() > new Date(specific.recordedAt).getTime() ? general : specific;
}

/** WhatsApp (canais com template oficial) fora da janela de atendimento só com template oficial. */
async function violatesChannelPolicy({ personId, channel, atInstant, officialTemplate }, tenant, transaction) {
  if (officialTemplate || !(await readOfficialTemplateChannels(tenant, transaction)).includes(channel)) return false;
  const since = new Date(atInstant.getTime() - (await readServiceWindowHours(tenant, transaction)) * HOUR_MS);
  const [row] = await sequelize.query(
    `SELECT 1 AS ok FROM crm.messages WHERE company_id = :companyId AND person_id = :personId AND channel = :channel AND direction = 'INBOUND'
        AND created_at > :since AND created_at <= :atInstant LIMIT 1`,
    { replacements: { companyId: tenant.companyId, personId, channel, since, atInstant }, type: QueryTypes.SELECT, transaction }
  );
  return !row;
}

/**
 * canSend(personId, channel, purpose, atInstant = now, options) — "posso falar com esta pessoa, neste canal, sobre este assunto,
 * agora?" (M9-D418). Ordem EXATA, o primeiro que bloqueia encerra: 1) supressão/opt-out (SUPPRESSED, OPT_OUT, NO_ADDRESS);
 * 2) quiet hours (nextEligibleAt = fim do silêncio); 3) frequency cap (única avaliação do cap; M9-D416); 4) consentimento/política
 * (NO_CONSENT, CHANNEL_POLICY). Finalidade fora das duas listas: 422 MKT_PURPOSE_UNKNOWN (erro de configuração, nunca envia).
 * options: { tenant, transaction, capDaVersao, officialTemplate, reserve: { runId, actionKey } }. Com transação, toma a trava de
 * pessoa + canal + finalidade (a mesma da supressão) e relê tudo depois dela; com `reserve`, a ação é reservada na mesma trava.
 * Devolve { allowed, reason, code?, message?, nextEligibleAt }.
 */
async function canSend(personId, channel, purpose, atInstant = new Date(), options = {}) {
  const { tenant, transaction, capDaVersao, officialTemplate, reserve } = options;
  const ch = String(channel || '').toUpperCase();
  const { purpose: p, requiresOptIn } = await classifyPurpose(purpose, tenant, transaction);
  await acquireSendLocks(tenant, personId, ch, [p], transaction);

  const addresses = await resolvePersonAddresses(personId, ch, tenant, transaction);
  const suppression = await findActiveSuppression({ hashes: addresses.map((a) => a.hash), personId, channel: ch, purpose: p, at: atInstant }, tenant, transaction);
  if (suppression) return blocked('SUPPRESSED', { suppressionId: suppression.id });
  const consent = await effectiveConsent(personId, ch, p, transaction);
  if (consent && consent.status === 'OPT_OUT') return blocked('OPT_OUT');
  if (addresses.length === 0) return blocked('NO_ADDRESS');

  const quiet = await checkQuietHours(atInstant, tenant, transaction);
  if (quiet.quiet) return blocked('QUIET_HOURS', { nextEligibleAt: quiet.nextAllowedAt });

  const frequency = await evaluateFrequencyForSend({ personId, channel: ch, purpose: p, atInstant, capDaVersao }, tenant, transaction);
  if (!frequency.allowed) return blocked('FREQUENCY_CAP', { nextEligibleAt: frequency.nextEligibleAt, count: frequency.count, limit: frequency.limit, windowDays: frequency.windowDays });

  if (requiresOptIn && !(consent && consent.status === 'OPT_IN')) return blocked('NO_CONSENT');
  if (await violatesChannelPolicy({ personId, channel: ch, atInstant, officialTemplate }, tenant, transaction)) return blocked('CHANNEL_POLICY');

  if (reserve) await reserveSendAction({ runId: reserve.runId, actionKey: reserve.actionKey, channel: ch, purpose: p, at: atInstant }, tenant, transaction);
  return { allowed: true, reason: null, nextEligibleAt: null, count: frequency.count, limit: frequency.limit };
}

module.exports = { canSend, effectiveConsent };
