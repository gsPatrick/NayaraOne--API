'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { findCompanyUser } = require('../governance.users');
const settings = require('./data-quality.settings');
const errors = require('./data-quality.errors');
const repository = require('./stewardship.repository');
const { parseDesignations } = require('./stewardship.input');
const { buildDomainViews } = require('./stewardship.view');

const ENTITY_TYPE = 'governance.data_domain';

async function domainCodes(tenant, transaction) {
  return settings.parseDomains(await getSetting(settings.DOMAINS_KEY, tenant, transaction, settings.DEFAULT_DOMAINS));
}

/** Domínios da empresa (os do parâmetro, criados sob demanda) com owner, stewards e pendências. */
async function listDomains(tenant, transaction) {
  const codes = await domainCodes(tenant, transaction);
  const domains = await repository.ensureDomains(tenant, codes, transaction);
  const assignments = await repository.currentAssignments(tenant, transaction, domains.map((d) => d.id));
  return buildDomainViews(codes, assignments);
}

async function viewOf(tenant, code, transaction) {
  return (await listDomains(tenant, transaction)).find((domain) => domain.code === code);
}

async function assertAssignable(userId, tenant, transaction) {
  const user = await findCompanyUser(userId, tenant, transaction);
  if (!user.exists) throw errors.userNotFound();
  if (!user.active) throw errors.assigneeInactive();
}

/**
 * PUT /data-quality/domains/:code/assignments (M9-D804 §3.1). Para cada papel presente no corpo, os vigentes passam a ser exatamente
 * os usuários listados: quem sai tem a linha fechada (`valid_until = now()`), quem entra abre linha nova, quem já estava vigente no
 * mesmo papel fica como está (idempotente, sem linha nova). Trocar o OWNER é um PUT com outro usuário OWNER. Papel ausente não muda.
 * Tudo na mesma transação, com a linha do domínio travada.
 */
async function designate(tenant, actor, rawCode, body, transaction) {
  const code = String(rawCode || '').trim().toUpperCase();
  const codes = await domainCodes(tenant, transaction);
  if (!codes.includes(code)) throw errors.domainInvalid();
  const designations = parseDesignations(body);
  for (const userId of new Set(designations.map((d) => d.userId))) await assertAssignable(userId, tenant, transaction);
  await repository.ensureDomains(tenant, codes, transaction);
  const domain = await repository.lockDomain(tenant, code, transaction);
  const before = await viewOf(tenant, code, transaction);
  const current = await repository.currentAssignments(tenant, transaction, [domain.id]);
  for (const role of new Set(designations.map((d) => d.role))) {
    const wanted = designations.filter((d) => d.role === role).map((d) => d.userId);
    const mine = current.filter((row) => row.role === role);
    await repository.closeAssignments(mine.filter((row) => !wanted.includes(row.user_id)).map((row) => row.id), 'REPLACED', transaction);
    for (const userId of wanted.filter((id) => !mine.some((row) => row.user_id === id))) {
      await repository.openAssignment(tenant, { domainId: domain.id, role, userId, designatedBy: actor.userId }, transaction);
    }
  }
  const after = await viewOf(tenant, code, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'governance.data_domain.designate', entityType: ENTITY_TYPE,
    entityId: domain.id, beforeJson: before, afterJson: after, reason: `Designação de responsáveis do domínio ${code}.`,
  }, transaction);
  return after;
}

module.exports = { listDomains, designate, domainCodes };
