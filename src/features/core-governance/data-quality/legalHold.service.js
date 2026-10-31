'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { parsePagination } = require('../api-governance/standards/pagination.helper');
const repository = require('./legalHold.repository');
const derive = require('./legalHold.derive');
const errors = require('./legalHold.errors');
const settings = require('./legalHold.settings');
const { parseCreate, parseRelease, parseListQuery, isUuid } = require('./legalHold.input');
const { AUDIT, SCOPE_TYPES, STATUS } = require('./legalHold.constants');

const read = (tenant, tx, key) => getSetting(key, tenant, tx, settings.LEGAL_HOLD_SETTING_DEFAULTS[key]);
const view = (hold) => ({
  id: hold.id, code: hold.code, reason: hold.reason, matterRef: hold.matterRef, scope: hold.scope, status: hold.status, createdBy: hold.createdBy, createdAt: hold.createdAt,
  releasedBy: hold.releasedBy, releasedAt: hold.releasedAt, releaseReason: hold.releaseReason, ...(hold.targetCount === undefined ? {} : { targetCount: hold.targetCount }),
});

/** Cada registro nomeado no escopo precisa existir na empresa (404 GOV_NOT_FOUND). */
async function assertScopeExists(tenant, scope, transaction) {
  for (const item of scope) {
    if (item.type === SCOPE_TYPES.ENTITY && !(await repository.recordExists(item.entityType, item.id, tenant.companyId, transaction))) throw errors.targetNotFound({ type: item.entityType, id: item.id });
    if ([SCOPE_TYPES.PERSON, SCOPE_TYPES.CONTRACT, SCOPE_TYPES.LEGAL_CASE].includes(item.type) && !(await repository.recordExists(item.type, item.id, tenant.companyId, transaction))) {
      throw errors.targetNotFound({ type: item.type, id: item.id });
    }
  }
}

/**
 * POST /legal-holds: cria a retenção e materializa o escopo na MESMA transação. Toma a trava exclusiva da empresa: espera as disposições em curso e as seguintes já enxergam a
 * retenção. Código repetido é 409; sem motivo/referência 422; escopo vazio 422. Audita a criação com o escopo.
 */
async function create(tenant, actor, body, transaction) {
  const input = parseCreate(body, Number(await read(tenant, transaction, settings.KEYS.ESCOPO_MAX)));
  await repository.lockCreation(tenant.companyId, transaction);
  if (await repository.codeTaken(tenant.companyId, input.code, transaction)) throw errors.codeDuplicate();
  await assertScopeExists(tenant, input.scope, transaction);
  const hold = await repository.insertHold({ groupId: tenant.groupId, companyId: tenant.companyId, code: input.code, reason: input.reason, matterRef: input.matterRef, scope: input.scope, createdBy: actor.userId }, transaction);
  await derive.expand(hold, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: AUDIT.CREATED, entityType: 'LegalHold', entityId: hold.id, beforeJson: null,
    afterJson: { ...view(hold), targets: await repository.countTargets(hold.id, transaction) }, reason: `Retenção legal ${hold.code} criada (${hold.matterRef}).`,
  }, transaction);
  return { ...view(hold), targets: await repository.countTargets(hold.id, transaction) };
}

async function list(tenant, query, transaction) {
  const page = await parsePagination(query, tenant, transaction, await read(tenant, transaction, settings.KEYS.PAGINA));
  const { rows, total } = await repository.list(tenant, parseListQuery(query), page, transaction);
  return { items: rows.map(view), page: page.page, pageSize: page.pageSize, total };
}

async function get(tenant, id, transaction) {
  const hold = isUuid(id) ? await repository.findById(tenant, id, transaction) : null;
  if (!hold) throw errors.notFound();
  return { ...view(hold), targets: await repository.countTargets(hold.id, transaction) };
}

/**
 * POST /legal-holds/:id/release (ação da linha 11 da M9-D852; a rota passa por MFA e pela confirmação com o impacto). Motivo obrigatório (422). Retenção já liberada é 409.
 * Os registros do escopo voltam ao ciclo normal de retenção. Audita antes e depois.
 */
async function release(tenant, actor, id, body, transaction) {
  const input = parseRelease(body);
  const before = isUuid(id) ? await repository.findById(tenant, id, transaction, { forUpdate: true }) : null;
  if (!before) throw errors.notFound();
  if (before.status === STATUS.RELEASED) throw errors.alreadyReleased();
  const after = await repository.release(before.id, actor.userId, input.reason, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: AUDIT.RELEASED, entityType: 'LegalHold', entityId: after.id, beforeJson: view(before), afterJson: view(after),
    reason: `Retenção legal ${after.code} liberada: ${input.reason}`,
  }, transaction);
  return view(after);
}

module.exports = { create, list, get, release };
