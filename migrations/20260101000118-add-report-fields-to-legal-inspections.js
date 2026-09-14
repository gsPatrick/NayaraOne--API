'use strict';

/**
 * Migration: adiciona campos de relatório imutável a "legal"."inspections".
 *
 * FIX (reportado pela cliente 14/09/2026, escopo Marco 5 — Vistorias): não existia geração de
 * relatório em PDF nem hash de integridade. O binário do PDF é gravado direto no Postgres
 * (bytea) em vez de depender de storage externo (S3) — decisão consciente, já que não existe
 * integração de storage real neste momento (ver ressalva em contractVersions.service.js sobre
 * o mesmo gap). `report_hash` é o SHA-256 dos bytes gravados, permitindo provar depois que o
 * PDF entregue ao cliente é byte-a-byte o mesmo que foi gerado (imutabilidade).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'inspections', schema: 'legal' },
      'report_pdf_bytes',
      { type: Sequelize.BLOB('long'), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'inspections', schema: 'legal' },
      'report_hash',
      { type: Sequelize.STRING(64), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'inspections', schema: 'legal' },
      'report_generated_at',
      { type: Sequelize.DATE, allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'inspections', schema: 'legal' }, 'report_pdf_bytes');
    await queryInterface.removeColumn({ tableName: 'inspections', schema: 'legal' }, 'report_hash');
    await queryInterface.removeColumn({ tableName: 'inspections', schema: 'legal' }, 'report_generated_at');
  },
};
