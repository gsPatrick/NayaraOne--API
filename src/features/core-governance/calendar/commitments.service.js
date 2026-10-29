'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const settings = require('./calendar.settings');
const { STATUS_TRANSITIONS } = require('./calendar.constants');
const { canManageCommitment, ADMIN_ROLE } = require('./calendar.permissions');
const { commitmentDeepLink } = require('./calendar.deeplinks');
const { severityFor } = require('./calendar.severity');
const { applyMapped } = require('./projector/projector.apply');
const { transition } = require('./sources/draft');
const { CANCEL } = require('./sources/sources.constants');
const { parseCreate, parsePatch } = require('./commitments.input');
const repository = require('./commitments.repository');
const { UUID } = require('./calendar.query');
const errors = require('./calendar.errors');

const ENTITY_TYPE = 'governance.calendar_commitment';
const isAdmin = (actor) => (actor.roles || []).some((r) => String(r).toUpperCase() === ADMIN_ROLE);
const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[key]);

/** Projeta o compromisso no calendário (origem COMMITMENT) na MESMA transação: criar/alterar = UPSERT; DONE/CANCELLED fecham o item. */
async function project(tenant, commitment, transaction) {
  const severityMap = settings.parseSeverityMap(await read(settings.SEVERITY_KEY, tenant, transaction));
  const draft = {
    sourceType: 'COMMITMENT',
    sourceId: commitment.id,
    title: commitment.title,
    ownerUserId: commitment.ownerUserId,
    dueAt: commitment.startsAt,
    endAt: commitment.endsAt,
    severity: severityFor('COMMITMENT', severityMap),
    status: commitment.status,
    deepLink: commitmentDeepLink(commitment.id),
  };
  // Mesma regra do projetor (matriz de status, versão e calendar.item.updated só quando algo muda de verdade).
  const event = { id: null, eventType: `governance.calendar_commitment.${commitment.status.toLowerCase()}`, occurredAt: new Date() };
  const closing = transition('COMMITMENT', commitment.id, commitment.status, commitment.status === 'CANCELLED' ? CANCEL.SOURCE_CANCELLED : null);
  return applyMapped(tenant, event, { items: [draft], transitions: [closing] }, transaction);
}

async function assertOwnerIsMember(ownerUserId, tenant, transaction) {
  if (!(await repository.isCompanyMember(ownerUserId, tenant, transaction))) {
    throw errors.validation('A pessoa responsável não pertence a esta empresa.', { field: 'ownerUserId' });
  }
}

function assertPeriod(startsAt, endsAt) {
  if (!(endsAt.getTime() > startsAt.getTime())) throw errors.commitmentInvalid();
}

async function createCommitment(tenant, actor, body, transaction) {
  const duration = Number(await read(settings.DURATION_KEY, tenant, transaction)) || settings.CALENDAR_SETTING_DEFAULTS[settings.DURATION_KEY];
  const input = parseCreate(body, duration);
  assertPeriod(input.startsAt, input.endsAt);
  const ownerUserId = input.ownerUserId || actor.userId;
  if (ownerUserId !== actor.userId && !isAdmin(actor)) throw errors.commitmentOwnerOnly();
  if (ownerUserId !== actor.userId) await assertOwnerIsMember(ownerUserId, tenant, transaction);
  const created = await repository.insert(tenant, { title: input.title, startsAt: input.startsAt, endsAt: input.endsAt, ownerUserId }, transaction);
  await project(tenant, created, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'governance.calendar_commitment.create',
    entityType: ENTITY_TYPE, entityId: created.id, beforeJson: null, afterJson: created, reason: 'Compromisso avulso criado no calendário.',
  }, transaction);
  return created;
}

async function getCommitment(tenant, id, transaction) {
  if (!UUID.test(String(id))) throw errors.notFound();
  const found = await repository.findById(id, tenant, transaction);
  if (!found) throw errors.notFound();
  return found;
}

async function updateCommitment(tenant, actor, id, body, transaction) {
  if (!UUID.test(String(id))) throw errors.notFound();
  const patch = parsePatch(body);
  const before = await repository.findById(id, tenant, transaction, { forUpdate: true });
  if (!before) throw errors.notFound();
  if (!canManageCommitment(actor, before)) throw errors.commitmentOwnerOnly();
  if (patch.ownerUserId && patch.ownerUserId !== before.ownerUserId) {
    if (!isAdmin(actor)) throw errors.commitmentOwnerOnly();
    await assertOwnerIsMember(patch.ownerUserId, tenant, transaction);
  }
  if (patch.status && patch.status !== before.status && !STATUS_TRANSITIONS[before.status].includes(patch.status)) {
    throw errors.commitmentTransition(before.status, patch.status);
  }
  const startsAt = patch.startsAt || new Date(before.startsAt);
  const endsAt = patch.endsAt || new Date(before.endsAt);
  assertPeriod(startsAt, endsAt);
  const updated = await repository.update(id, tenant, {
    title: patch.title || before.title, startsAt, endsAt, ownerUserId: patch.ownerUserId || before.ownerUserId, status: patch.status || before.status,
  }, transaction);
  await project(tenant, updated, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'governance.calendar_commitment.update',
    entityType: ENTITY_TYPE, entityId: id, beforeJson: before, afterJson: updated, reason: 'Compromisso avulso alterado no calendário.',
  }, transaction);
  return updated;
}

module.exports = { createCommitment, getCommitment, updateCommitment };
