'use strict';

/**
 * Fase 13 (testes adversariais consolidados) — achado real: `requestInvoice`
 * (nfse.service.js) não tinha NENHUMA proteção contra duplicidade. Chamar duas vezes
 * para a mesma origem (ex: a mesma comissão confirmada, reprocessada por retry) criava
 * DUAS NFS-e distintas — exatamente o item "(Fiscal) Duplicidade de NFS-e" do Caderno,
 * que o teste adversarial consolidado cobra.
 *
 * Índice único parcial: no máximo um InvoiceRequest "em andamento" (REQUESTED, SUBMITTED,
 * UNKNOWN ou AUTHORIZED) por (company_id, source_type, source_id). REJECTED/CANCELED ficam
 * de fora do índice — uma NFS-e rejeitada ou cancelada pode ser solicitada de novo pra
 * mesma origem (não é duplicidade, é correção de um pedido que não vingou).
 */
module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(`
      CREATE UNIQUE INDEX invoice_requests_source_dedup_unique
        ON "correspondent"."invoice_requests" (company_id, source_type, source_id)
        WHERE status IN ('REQUESTED', 'SUBMITTED', 'UNKNOWN', 'AUTHORIZED');
    `);
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP INDEX IF EXISTS correspondent.invoice_requests_source_dedup_unique;');
  },
};
