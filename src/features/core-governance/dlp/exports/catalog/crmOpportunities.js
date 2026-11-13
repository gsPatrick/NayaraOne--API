'use strict';

const { collectOpportunityRows, EXPORT_FIELDS } = require('../../../../crm/opportunitiesExport.service');
const { pick, UUID } = require('./filters');

const LABELS = {
  id: 'Id', stage: 'Etapa', temperature: 'Temperatura', expectedValue: 'Valor esperado', wonReason: 'Motivo do ganho', lostReason: 'Motivo da perda', withdrawnReason: 'Motivo da desistência',
  closedAt: 'Fechamento', nextActionDueAt: 'Próxima ação em', personId: 'Pessoa', propertyId: 'Imóvel', ownerUserId: 'Responsável', createdAt: 'Criada em',
};

/** Exportação de oportunidades do CRM, antes GET /crm/opportunities/export. Só identificadores opacos e motivos estruturados (decisão M3-21), sem texto livre nem dado cadastral. */
module.exports = {
  code: 'crm.opportunities',
  label: 'Oportunidades do CRM',
  onDemand: true,
  formats: ['CSV', 'XLSX', 'PDF'],
  permission: 'crm:opportunities:export',
  registryTable: 'crm.opportunities',
  // Livro do Marco 3 §18 ("Exportar base de clientes — Permissão, MFA, volume limit, audit") e M3-21/CRM-TS-013: a exportação
  // de oportunidades exige justificativa e MFA recente mesmo quando o registro de classificação da tabela der classe menor.
  minClassification: 'HIGH',
  sourceFiles: ['features/crm/opportunitiesExport.service.js'],
  lineage: {
    area: 'OTHER', ownerDomain: 'CRM', criticality: 'NORMAL', description: 'Exportação das oportunidades do CRM (CSV, XLSX ou PDF) pelo POST /exports, com finalidade, MFA, expiração e auditoria.',
    readModel: { code: 'crm.opportunities', description: 'Tabela de oportunidades do CRM: o conjunto de onde a exportação é lida.' },
    columns: ['crm.opportunities.stage', 'crm.opportunities.expected_value', 'crm.opportunities.person_id', 'crm.opportunities.property_id'],
  },
  columns: EXPORT_FIELDS.map((key) => ({ key, label: LABELS[key] || key, classification: 'HIGH', numeric: key === 'expectedValue' })),
  parseFilter: (filter) => pick(filter, ['stage', 'personId', 'propertyId'], { personId: UUID, propertyId: UUID, stage: /^[A-Za-z_]{1,40}$/ }),
  estimate: async (_ctx, filter, transaction) => (await collectOpportunityRows(filter, transaction)).length,
  collect: async (_ctx, filter, transaction) => ({ rows: await collectOpportunityRows(filter, transaction) }),
};
