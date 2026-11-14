'use strict';

/**
 * Migration de correção: a migration 349 criou por engano uma tabela
 * "correspondent"."tax_documents" DUPLICADA — já existia "finance"."tax_documents" desde a
 * migration 057 (scaffold de documento fiscal: NFS-e/DIMOB/comprovante de retenção), nunca lido
 * antes de criar o model novo (violação do PADRAO_COMPONENTES_E_REGRAS.md §2.8/2.9, mesma classe
 * de bug já documentada pra inventory_items). Corrigido: remove a tabela duplicada e ESTENDE a
 * tabela existente com a coluna que faltava (`invoice_request_id`), em vez de duplicar.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."tax_documents";');
    await queryInterface.dropTable({ tableName: 'tax_documents', schema: 'correspondent' }).catch(() => {});

    await queryInterface.addColumn(
      { tableName: 'tax_documents', schema: 'finance' },
      'invoice_request_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'invoice_requests', schema: 'correspondent' }, key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }
    );
    await sequelize.query(`
      CREATE UNIQUE INDEX tax_documents_invoice_request_unique ON "finance"."tax_documents" (invoice_request_id)
        WHERE invoice_request_id IS NOT NULL AND deleted_at IS NULL;
    `);
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP INDEX IF EXISTS finance.tax_documents_invoice_request_unique;');
    await queryInterface.removeColumn({ tableName: 'tax_documents', schema: 'finance' }, 'invoice_request_id');
  },
};
