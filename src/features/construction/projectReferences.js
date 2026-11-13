'use strict';

const { assertUnitInCompany, assertPropertyInCompany, assertActiveMember } = require('./companyRefs');
const { assertActiveProjectType } = require('./projectTypes.service');

/**
 * Referências da obra conferidas contra a empresa antes de gravar (verificação independente do Marco 6: M6-95 —
 * a obra aceitava unit_id de outra empresa; e varredura das demais referências): imóvel, unidade, responsável (membro
 * ativo) e tipo de obra (ativo, da empresa). Só confere os campos presentes no payload (criação ou edição parcial).
 */
async function assertProjectReferences(payload, companyId, transaction) {
  const { propertyId, unitId, responsibleUserId, projectTypeId } = payload || {};
  if (propertyId !== undefined) await assertPropertyInCompany(propertyId, companyId, transaction);
  if (unitId !== undefined) await assertUnitInCompany(unitId, companyId, transaction);
  if (responsibleUserId !== undefined) await assertActiveMember(responsibleUserId, companyId, transaction);
  if (projectTypeId !== undefined) await assertActiveProjectType(projectTypeId, companyId, transaction);
}

module.exports = { assertProjectReferences };
