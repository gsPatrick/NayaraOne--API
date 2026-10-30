'use strict';

const { rows, one, centsSql } = require('./sql');

/** Impacto de excluir um imóvel (linha 4): proprietários, ofertas, mídia, documentos, contratos, oportunidades e obras que dependem dele. */
async function property({ id, transaction, itemsMax }) {
  const p = await one(transaction, 'SELECT id, title, internal_code FROM real_estate.properties WHERE id = :id AND deleted_at IS NULL', { id }, 'Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  const n = async (sql) => (await rows(transaction, sql, { id }))[0].n;
  const [contracts] = await rows(transaction, `SELECT COUNT(*)::int AS n, ${centsSql('total_value')} AS cents FROM legal.contracts WHERE property_id = :id AND deleted_at IS NULL AND status NOT IN ('TERMINATED','CLOSED','CANCELLED')`, { id });
  const contractItems = await rows(transaction, `SELECT id, contract_number, total_value FROM legal.contracts WHERE property_id = :id AND deleted_at IS NULL AND status NOT IN ('TERMINATED','CLOSED','CANCELLED') ORDER BY created_at LIMIT :limit`, { id, limit: itemsMax });
  const counts = {
    owners: await n('SELECT COUNT(*)::int AS n FROM real_estate.property_owners WHERE property_id = :id AND deleted_at IS NULL'),
    offers: await n('SELECT COUNT(*)::int AS n FROM real_estate.property_offers WHERE property_id = :id AND deleted_at IS NULL'),
    media: await n('SELECT COUNT(*)::int AS n FROM real_estate.property_media WHERE property_id = :id'),
    documents: await n('SELECT COUNT(*)::int AS n FROM real_estate.property_documents WHERE property_id = :id'),
    openContracts: contracts.n,
    opportunities: await n('SELECT COUNT(*)::int AS n FROM crm.opportunities WHERE property_id = :id AND deleted_at IS NULL'),
    projects: await n('SELECT COUNT(*)::int AS n FROM construction.projects WHERE property_id = :id AND deleted_at IS NULL'),
  };
  return {
    code: p.internal_code,
    label: p.title,
    impact: {
      counts,
      totalAmountCents: Number(contracts.cents),
      blockers: [],
      items: contractItems.map((c) => ({ type: 'CONTRACT', id: c.id, label: `Contrato ${c.contract_number}`, amount: c.total_value })),
    },
  };
}

module.exports = { property };
