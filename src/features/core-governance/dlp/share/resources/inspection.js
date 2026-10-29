'use strict';

const { Inspection } = require('../../../../../models');
const { govNotFound } = require('../../../governance.errors');

/** Vistoria (legal.inspections): o laudo em dados, sem o PDF; identificadores do imóvel e do contrato saem mascarados para o visitante. */
module.exports = {
  code: 'legal.inspection',
  label: 'Laudo de vistoria',
  permission: 'legal:read',
  fields: {
    id: 'LOW', inspectionType: 'LOW', status: 'LOW', scheduledAt: 'LOW', completedAt: 'LOW', propertyId: 'HIGH', contractId: 'HIGH', reportHash: 'MEDIUM', reportGeneratedAt: 'LOW',
  },
  async assertShareable(_ctx, id, transaction) {
    if (!(await Inspection.findByPk(id, { attributes: ['id'], transaction }))) throw govNotFound('Registro não encontrado.');
  },
  async load(_ctx, id, transaction) {
    const inspection = await Inspection.findByPk(id, { attributes: { exclude: ['reportPdfBytes'] }, transaction });
    if (!inspection) return null;
    return {
      data: {
        id: inspection.id, inspectionType: inspection.inspectionType, status: inspection.status, scheduledAt: inspection.scheduledAt, completedAt: inspection.completedAt,
        propertyId: inspection.propertyId, contractId: inspection.contractId, reportHash: inspection.reportHash, reportGeneratedAt: inspection.reportGeneratedAt,
      },
    };
  },
};
