'use strict';

const { collectOpportunityRows, EXPORT_FIELDS } = require('../../../../crm/opportunitiesExport.service');
const { pick, UUID } = require('./filters');
const { getEffectiveAccess } = require('../../../../memberships/effectivePermissions.service');
const { resolveOpportunityOwnerScope } = require('../../../../crm/opportunityScope.guard');
const { readCrmExportMaxRows } = require('../../../../crm/opportunitiesExport.settings');

/** Escopo de carteira de quem pede (livro do Marco 3 §18; CRM-TS-012): permissões efetivas de agora, como o resto do pedido. */
async function ownerScopeOf(ctx, transaction) {
  const { permissions } = await getEffectiveAccess(ctx.userId, ctx.companyId, transaction);
  return resolveOpportunityOwnerScope({ permissions, userId: ctx.userId });
}

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
  // A estimativa (que passa pelo teto de volume do guard) e o arquivo contam a mesma carteira: o corretor de escopo próprio só exporta a dele.
  estimate: async (ctx, filter, transaction) => (await collectOpportunityRows(filter, transaction, await ownerScopeOf(ctx, transaction))).length,
  // DEC-049: teto próprio da exportação do CRM (exportacao.crm.linhas_maximo), somado ao teto da classe no guard (vale o menor).
  volumeCap: (ctx, transaction) => readCrmExportMaxRows(ctx, transaction),
  collect: async (ctx, filter, transaction) => ({ rows: await collectOpportunityRows(filter, transaction, await ownerScopeOf(ctx, transaction)) }),
};
