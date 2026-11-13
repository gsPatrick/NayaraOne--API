'use strict';

/**
 * Apoio dos testes do CRM (correções M3CA): usuário com vínculo na empresa e papel com as permissões pedidas, pessoa e
 * oportunidade pelos serviços normais. Só usa o que já existia no commit de base, para o teste falhar por asserção (e não por
 * módulo ausente) quando rodado na base 41addaa2.
 */
const { randomUUID } = require('node:crypto');
const { sequelize, User, Role, RolePermission, UserMembership, Permission } = require('../../src/models');
const peopleService = require('../../src/features/people/person.service');
const opportunityService = require('../../src/features/crm/opportunity.service');
const propertiesService = require('../../src/features/properties/properties.service');

const FUTURE = () => new Date(Date.now() + 2 * 86400000);

/** Usuário ATIVO com vínculo ATIVO na empresa do tenant e papel novo com `permissions` (códigos do catálogo). */
async function createMember(tenant, transaction, { permissions = [], label = 'membro', membershipStatus = 'ACTIVE' } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const user = await User.create(
    { name: `Teste ${label} ${suffix}`, email: `m3ca-${label}-${suffix}@teste.nayaraone.test`, passwordHash: 'x'.repeat(60), status: 'ACTIVE' },
    { transaction }
  );
  const role = await Role.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, name: `M3CA ${label} ${suffix}`, description: 'Papel de teste M3CA', isSystem: false },
    { transaction }
  );
  for (const code of permissions) {
    const permission = await Permission.findOne({ where: { code }, transaction });
    if (!permission) throw new Error(`permissão ${code} ausente do catálogo`);
    await RolePermission.create({ roleId: role.id, permissionId: permission.id }, { transaction });
  }
  await UserMembership.create(
    { userId: user.id, groupId: tenant.groupId, companyId: tenant.companyId, roleId: role.id, status: membershipStatus },
    { transaction }
  );
  return user.id;
}

/** Usuário ativo SEM vínculo com a empresa (responsável inválido). */
async function createOutsider(transaction) {
  const suffix = randomUUID().slice(0, 8);
  const user = await User.create(
    { name: `Fora ${suffix}`, email: `m3ca-fora-${suffix}@teste.nayaraone.test`, passwordHash: 'x'.repeat(60), status: 'ACTIVE' },
    { transaction }
  );
  return user.id;
}

async function createPerson(tenant, transaction, name = 'Cliente') {
  return peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `${name} M3CA ${randomUUID().slice(0, 8)}`, allowDuplicate: true },
    tenant.userId,
    transaction
  );
}

async function createOpportunity(tenant, transaction, extra = {}, actorUserId = tenant.userId) {
  const person = extra.personId ? { id: extra.personId } : await createPerson(tenant, transaction);
  return opportunityService.createOpportunity(
    { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, nextAction: 'Ligar para o cliente', nextActionDueAt: FUTURE(), ...extra },
    actorUserId,
    transaction
  );
}

async function createTestProperty(tenant, transaction) {
  const suffix = randomUUID().slice(0, 8);
  return propertiesService.createProperty(
    { groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel M3CA ${suffix}`, internalCode: `M3CA-${suffix}`, propertyType: 'RESIDENTIAL', city: 'Ribeirão Preto', areaTotalM2: 100 },
    tenant.userId,
    transaction
  );
}

/** Usuários ativos da empresa com a permissão (a "gerência" padrão é crm:dashboard:read). */
async function usersWithPermission(tenant, code, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT um.user_id FROM core.user_memberships um
       JOIN core.role_permissions rp ON rp.role_id = um.role_id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE um.company_id = :c AND um.status = 'ACTIVE' AND um.deleted_at IS NULL AND p.code = :code`,
    { replacements: { c: tenant.companyId, code }, transaction }
  );
  return rows.map((r) => r.user_id);
}

module.exports = { createMember, createOutsider, createPerson, createOpportunity, createTestProperty, usersWithPermission, FUTURE };
