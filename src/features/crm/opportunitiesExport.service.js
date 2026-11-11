'use strict';

const { listOpportunities } = require('./opportunity.service');

/**
 * M3-21 — linhas da exportação de oportunidades do CRM (livro do Marco 3 §18: "Exportar base de clientes — Permissão, MFA, volume
 * limit, audit"). A exportação sai SÓ pelo caminho vivo POST /exports (M9-D822, catálogo `crm.opportunities` em
 * core-governance/dlp/exports/catalog/crmOpportunities.js): a permissão dedicada `crm:opportunities:export`, a finalidade com
 * justificativa, o MFA recente, o teto de volume da classe (parâmetro `governanca.dlp.volume_teto_por_classe`, HIGH) e a auditoria
 * do pedido e do arquivo ficam no guard do DLP. O caminho antigo GET /crm/opportunities/export responde 410 e o gerador síncrono
 * que só os testes chamavam foi retirado (DI-M3CB-3).
 *
 * Campos (decisão M3-21): só identificadores opacos e motivos estruturados — id, etapa, temperatura, valor esperado, motivos
 * (enum do M3-12), datas, ids da pessoa, do imóvel e do responsável. Fica de fora `nextAction` (texto livre) e qualquer dado
 * cadastral de pessoa (nome, CPF/CNPJ, contato, endereço).
 *
 * Carteira (livro §18 "Corretor visualizar carteira alheia"; CRM-TS-012): o corretor de escopo próprio exporta só a própria
 * carteira — a listagem é a mesma da tela, com o mesmo `ownerScope`.
 */
const EXPORT_FIELDS = [
  'id',
  'stage',
  'temperature',
  'expectedValue',
  'wonReason',
  'lostReason',
  'withdrawnReason',
  'closedAt',
  'nextActionDueAt',
  'personId',
  'propertyId',
  'ownerUserId',
  'createdAt',
];

function toExportRow(opportunity) {
  const json = opportunity.toJSON ? opportunity.toJSON() : opportunity;
  const row = {};
  for (const field of EXPORT_FIELDS) {
    // o model renomeia createdAt para created_at: no toJSON a chave é created_at
    const value = field === 'createdAt' ? (json.createdAt ?? json.created_at) : json[field];
    row[field] = value instanceof Date ? value.toISOString() : value === undefined ? null : value;
  }
  return row;
}

/** Linhas da exportação (só os campos de EXPORT_FIELDS), pela mesma listagem da tela e com o escopo de carteira de quem pediu. */
async function collectOpportunityRows(filters, transaction, ownerScope) {
  const applied = {
    stage: (filters && filters.stage) || undefined,
    personId: (filters && filters.personId) || undefined,
    propertyId: (filters && filters.propertyId) || undefined,
    ownerScope: ownerScope || undefined,
  };
  return (await listOpportunities(transaction, applied)).map(toExportRow);
}

module.exports = { EXPORT_FIELDS, collectOpportunityRows };
