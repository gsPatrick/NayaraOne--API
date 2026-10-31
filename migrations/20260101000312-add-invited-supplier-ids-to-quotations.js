'use strict';

/**
 * Migration: fecha gap real de auditoria contratual (Anexo I, seção "COMPRAS/PROCUREMENT +
 * SEGUROS — BLINDADO + GUIA", "RFQ sem convite dirigido a fornecedores específicos") —
 * qualquer fornecedor podia registrar oferta (supplier_offers) contra uma Quotation OPEN, sem
 * nenhum conceito de convite prévio.
 *
 * Adiciona coluna opcional "invited_supplier_ids" (JSONB, array de Person ids) em
 * "procurement"."quotations". null (ou array vazio) preserva o comportamento atual — qualquer
 * fornecedor pode ofertar (decisão de compatibilidade retroativa, nenhuma migração de dado
 * necessária nas quotations já existentes). Quando preenchida, só os fornecedores da lista
 * podem submeter oferta (ver procurement.service.js#submitSupplierOffer).
 *
 * Idempotente: usa `addColumn` guardado por checagem de coluna existente, mesmo espírito dos
 * guards de `nayara_runtime` já usados nas migrations de grant deste schema — nunca falha se
 * reaplicada (ex.: reexecução parcial de migrate em CI).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable({ tableName: 'quotations', schema: 'procurement' });
    if (!table.invited_supplier_ids) {
      await queryInterface.addColumn(
        { tableName: 'quotations', schema: 'procurement' },
        'invited_supplier_ids',
        {
          type: Sequelize.JSONB,
          allowNull: true,
          comment: 'Array de Person ids convidados a ofertar nesta RFQ — null/[] preserva o comportamento antigo (qualquer fornecedor pode ofertar).',
        }
      );
    }
  },

  down: async (queryInterface) => {
    const table = await queryInterface.describeTable({ tableName: 'quotations', schema: 'procurement' });
    if (table.invited_supplier_ids) {
      await queryInterface.removeColumn({ tableName: 'quotations', schema: 'procurement' }, 'invited_supplier_ids');
    }
  },
};
