'use strict';

const { Group } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * "core"."groups" não tem RLS (é o topo da hierarquia group -> company -> unit — não existe
 * um "tenant pai" acima dele para segregar). Autorização é feita via requirePermission na rota.
 */
async function createGroup(payload, actorUserId) {
  const { name, legalName, taxId, status } = payload;
  if (!name) {
    throw AppError.badRequest('O campo "name" é obrigatório.', 'GROUP_VALIDATION');
  }
  return Group.create({
    name,
    legalName: legalName || null,
    taxId: taxId || null,
    status: status || 'ACTIVE',
    createdBy: actorUserId || null,
    updatedBy: actorUserId || null,
  });
}

async function listGroups() {
  return Group.findAll({ order: [['created_at', 'DESC']] });
}

async function getGroup(id) {
  const group = await Group.findByPk(id);
  if (!group) throw AppError.notFound('Grupo não encontrado.', 'GROUP_NOT_FOUND');
  return group;
}

async function updateGroup(id, payload, actorUserId) {
  const group = await getGroup(id);
  const { name, legalName, taxId, status } = payload;
  if (name !== undefined) group.name = name;
  if (legalName !== undefined) group.legalName = legalName;
  if (taxId !== undefined) group.taxId = taxId;
  if (status !== undefined) group.status = status;
  group.updatedBy = actorUserId || null;
  await group.save();
  return group;
}

async function deleteGroup(id, actorUserId) {
  const group = await getGroup(id);
  group.deletedBy = actorUserId || null;
  await group.save();
  await group.destroy(); // soft delete (paranoid: true no model)
  return { id };
}

module.exports = { createGroup, listGroups, getGroup, updateGroup, deleteGroup };
