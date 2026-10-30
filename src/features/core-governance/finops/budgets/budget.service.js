'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { findCompanyUser } = require('../../governance.users');
const { allowedDomains } = require('../ledger.service');
const { readFinopsParams } = require('../finops.params');
const { AUDIT_ENTITY } = require('./budget.constants');
const E = require('./budget.errors');
const input = require('./budget.input');
const repo = require('./budget.repository');
const { evaluateBudget } = require('./budget.evaluate');
const { viewOf, listViews } = require('./budget.view');
const { monthKeyOf } = require('./budget.period');

async function assertOwnerActive(tenant, ownerUserId, transaction) {
  const owner = await findCompanyUser(ownerUserId, tenant, transaction);
  if (!owner.active) throw E.ownerInvalid();
}

const snapshot = (b) => ({ environment: b.environment, domain: b.domain, period: b.period, amountCents: Number(b.amount_cents), ownerUserId: b.owner_user_id });

/** Cria o orçamento do escopo (M9-D861 §3.1) e já avalia o mês corrente: orçamento novo sobre gasto que já passou de um limiar avisa na hora. */
async function createBudget(tenant, body, actorUserId, transaction, { now = new Date() } = {}) {
  const params = await readFinopsParams(tenant, transaction);
  const scope = input.parseScope(body || {}, { defaultEnvironment: params.environment, domains: await allowedDomains(tenant, transaction) });
  const amountCents = input.parseAmount((body || {}).amountCents);
  const ownerUserId = input.parseOwner((body || {}).ownerUserId);
  await assertOwnerActive(tenant, ownerUserId, transaction);
  const row = await repo.insert(tenant, { ...scope, amountCents, ownerUserId }, actorUserId, transaction);
  if (!row) throw E.duplicate();
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'governance.budget.created', entityType: AUDIT_ENTITY, entityId: row.id,
    beforeJson: null, afterJson: snapshot(row), reason: 'Orçamento de custos criado.',
  }, transaction);
  await evaluateBudget(tenant, row.id, monthKeyOf(now), transaction, { now });
  return viewOf(tenant, row, monthKeyOf(now), now, transaction);
}

/** Altera valor e/ou responsável (auditoria antes e depois). Não repete limiar já disparado; limiar novo que o valor menor passe a atingir dispara. */
async function updateBudget(tenant, id, body, actorUserId, transaction, { now = new Date() } = {}) {
  if (!input.isUuid(id)) throw E.notFound();
  const before = await repo.find(tenant, id, transaction, { lock: true });
  if (!before) throw E.notFound();
  const patch = body || {};
  const amountCents = patch.amountCents === undefined ? Number(before.amount_cents) : input.parseAmount(patch.amountCents);
  const ownerUserId = patch.ownerUserId === undefined ? before.owner_user_id : input.parseOwner(patch.ownerUserId);
  if (ownerUserId !== before.owner_user_id) await assertOwnerActive(tenant, ownerUserId, transaction);
  const row = await repo.update(tenant, id, { amountCents, ownerUserId }, actorUserId, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'governance.budget.updated', entityType: AUDIT_ENTITY, entityId: id,
    beforeJson: snapshot(before), afterJson: snapshot(row), reason: 'Orçamento de custos alterado.',
  }, transaction);
  await evaluateBudget(tenant, id, monthKeyOf(now), transaction, { now });
  return viewOf(tenant, row, monthKeyOf(now), now, transaction);
}

module.exports = { createBudget, updateBudget, listBudgets: listViews };
