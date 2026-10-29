'use strict';

const { mktError } = require('../marketing.errors');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishMarketingEvent } = require('../marketing.events.publish');
const { recordConsent } = require('../../people/personConsents.service');
const { normalizeAddress, hashAddress, resolvePersonAddresses, personsOfAddressHash } = require('./address');
const { acquireSendLocks } = require('./sendLock');
const { readPurposeLists, readDefaultCountryCode } = require('./suppression.settings');
const { normalizePurpose } = require('./purposes');
const repo = require('./suppression.repository');
const { cancelPendingForSuppression } = require('./suppression.effect');

const MANAGE_PERMISSION = 'marketing:suppression:manage';
const REASONS = Object.freeze(['OPT_OUT', 'BOUNCE', 'COMPLAINT', 'LEGAL', 'MANUAL']);
const CONSENT_CHANNELS = Object.freeze(['PHONE', 'WHATSAPP', 'EMAIL']);
const ALL_PURPOSES = 'ALL';
const AUDIT_ENTITY = 'marketing.suppression';

/** Finalidades cuja trava precisa ser tomada: a informada, ou todas as conhecidas quando a supressão vale para qualquer finalidade. */
async function purposesToLock(purpose, tenant, transaction) {
  if (purpose) return [purpose];
  const { requireOptIn, noOptIn } = await readPurposeLists(tenant, transaction);
  return [...requireOptIn, ...noOptIn];
}

/** Hashes a suprimir: o endereço informado (normalizado) ou todos os endereços da pessoa no canal. */
async function addressesToSuppress({ personId, channel, address }, tenant, transaction) {
  if (address) {
    const normalized = normalizeAddress(channel, address, await readDefaultCountryCode(tenant, transaction));
    if (!normalized) throw mktError(422, 'MKT_VALIDATION', 'Endereço inválido para o canal.', { channel });
    return [hashAddress(normalized)];
  }
  return (await resolvePersonAddresses(personId, channel, tenant, transaction)).map((a) => a.hash);
}

async function recordOptOutConsent({ personId, channel, purpose, actor }, transaction) {
  if (!personId || !CONSENT_CHANNELS.includes(channel)) return null;
  // skipOptOutHandler: esta função JÁ é o serviço do opt-out (M9-D419); o tratador de Pessoas não pode chamá-la de volta.
  return recordConsent(personId, { channel, purpose: purpose || ALL_PURPOSES, status: 'OPT_OUT' }, actor, transaction, { skipOptOutHandler: true });
}

/**
 * Cria a supressão (M9-D418). Serviço do sistema: automática (SAIR, PARAR..., descadastro, bounce permanente, reclamação, número
 * inválido) ou manual. O endereço nunca é guardado em claro (sha256 do normalizado). Na MESMA transação: toma a trava de pessoa +
 * canal + finalidade (a mesma do canSend), grava (duplicada devolve a existente), audita, registra o OPT_OUT no consentimento da
 * pessoa, cancela o que está agendado (SKIPPED/SUPPRESSED, run BLOCKED) e, SÓ quando o motivo é OPT_OUT, emite customer.opted_out
 * (uma vez; BOUNCE, COMPLAINT, LEGAL e MANUAL não emitem, M9-D419). Automação nunca reverte.
 * input: { personId?, channel, address?, purpose?, reason, source, expiresAt?, actor?, consentRecorded?, occurredAt? } (precisa de
 * personId ou address; consentRecorded: o OPT_OUT já foi gravado em Pessoas pelo chamador, então não se grava de novo).
 */
async function suppress(input, tenant, transaction) {
  const channel = String(input.channel || '').toUpperCase();
  const purpose = input.purpose ? normalizePurpose(input.purpose) : null;
  if (!channel || !REASONS.includes(input.reason) || !String(input.source || '').trim() || (!input.personId && !input.address)) {
    throw mktError(422, 'MKT_VALIDATION', 'Dados inválidos para a supressão.', { campos: ['channel', 'reason', 'source', 'personId|address'] });
  }
  if (input.personId) await acquireSendLocks(tenant, input.personId, channel, await purposesToLock(purpose, tenant, transaction), transaction);
  const hashes = await addressesToSuppress({ personId: input.personId, channel, address: input.address }, tenant, transaction);
  if (hashes.length === 0) throw mktError(422, 'MKT_NO_ADDRESS', 'A pessoa não tem endereço de contato utilizável neste canal.', { channel });

  const results = [];
  for (const addressHash of hashes) {
    results.push(await repo.insertSuppression({ personId: input.personId, addressHash, channel, purpose, reason: input.reason, source: input.source, expiresAt: input.expiresAt, actor: input.actor }, tenant, transaction));
  }
  const created = results.filter((r) => r.created);
  const base = { suppressions: results.map((r) => r.row), replay: created.length === 0, blockedRuns: [] };
  if (created.length === 0) return base;

  for (const { row } of created) {
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: input.actor || null, action: 'marketing.suppression.created', entityType: AUDIT_ENTITY, entityId: row.id,
      beforeJson: null, afterJson: { channel, purpose, reason: input.reason, source: input.source, addressHash: row.address_hash }, reason: `Supressão criada (${input.reason}) pela origem ${input.source}.`,
    }, transaction);
  }
  const persons = input.personId ? [input.personId] : await personsOfAddressHash(hashes[0], channel, tenant, transaction);
  if (['OPT_OUT', 'COMPLAINT'].includes(input.reason) && !input.consentRecorded) await recordOptOutConsent({ personId: input.personId, channel, purpose, actor: input.actor }, transaction);
  base.blockedRuns = await cancelPendingForSuppression({ personIds: persons, channel, purpose }, tenant, transaction);
  if (input.reason === 'OPT_OUT') {
    const occurredAt = input.occurredAt || new Date().toISOString();
    for (const personId of persons) {
      await publishMarketingEvent({
        type: 'customer.opted_out', payload: { personId, channel, purpose: purpose || ALL_PURPOSES, source: String(input.source).slice(0, 60), occurredAt }, tenant,
        idempotencyKey: `customer.opted_out:${created[0].row.id}:${personId}`,
      }, transaction);
    }
  }
  return base;
}

function assertManageAllowed(permissions) {
  if (!Array.isArray(permissions) || !permissions.includes(MANAGE_PERMISSION)) {
    throw mktError(403, 'MKT_FORBIDDEN', 'Você não pode remover supressões.', { required: MANAGE_PERMISSION });
  }
}

/**
 * Remove a supressão: só com `marketing:suppression:manage`, motivo e a prova do novo consentimento (um OPT_IN registrado em
 * Pessoas DEPOIS da supressão, da mesma pessoa e canal). Auditada com antes e depois. Não existe rota HTTP do Marketing para isso.
 */
async function liftSuppression(suppressionId, { reason, consentId }, { tenant, actor, permissions }, transaction) {
  assertManageAllowed(permissions);
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw mktError(422, 'MKT_VALIDATION', 'Informe o motivo para remover a supressão.', { campo: 'reason' });
  const current = await repo.getForUpdate(suppressionId, tenant, transaction);
  if (!current) throw mktError(404, 'MKT_SUPPRESSION_NOT_FOUND', 'Supressão não encontrada.', { suppressionId });
  if (!current.active) return { suppression: current, replay: true };
  const consent = consentId ? await repo.getConsent(consentId, tenant, transaction) : null;
  const proven = consent && consent.status === 'OPT_IN' && consent.person_id === current.person_id && consent.channel === current.channel
    && new Date(consent.recorded_at).getTime() > new Date(current.created_at).getTime()
    && (!current.purpose || [current.purpose, ALL_PURPOSES].includes(consent.purpose));
  if (!proven) throw mktError(422, 'MKT_CONSENT_PROOF_REQUIRED', 'Registre um novo consentimento (OPT_IN) da pessoa antes de remover a supressão.', { suppressionId });
  const lifted = await repo.markLifted(suppressionId, actor, tenant, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor || null, action: 'marketing.suppression.lifted', entityType: AUDIT_ENTITY, entityId: suppressionId,
    beforeJson: { active: true, reason: current.reason, source: current.source }, afterJson: { active: false, consentId, liftedBy: actor || null }, reason: why,
  }, transaction);
  return { suppression: lifted, replay: false };
}

module.exports = { suppress, liftSuppression, MANAGE_PERMISSION, REASONS };
