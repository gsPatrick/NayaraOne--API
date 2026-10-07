'use strict';

/**
 * Migration: estende o MESMO padrão de idempotência de captura offline já usado em
 * "construction"."daily_reports" (M6-94 — ver migrations/20260101000192-alter-construction-
 * daily_reports-append-only-and-shift.js e dailyReports.service.js#createDailyReport) para
 * "construction"."stage_measurements" e "construction"."material_requests" (item 3 do
 * fechamento de gaps pós-Marco 6).
 *
 * Mesmo mecanismo: coluna `idempotency_key` (STRING(128), opcional) + índice ÚNICO PARCIAL
 * (só sobre `idempotency_key IS NOT NULL`, pra não forçar unicidade de NULL contra NULL e não
 * afetar nenhum registro já existente sem idempotency_key). O app gera a chave no dispositivo
 * (ex.: um app de campo offline, cenário real de obra sem conexão) ao criar a medição/
 * requisição de material; ao sincronizar, reenviar a MESMA `idempotencyKey` devolve o registro
 * já existente em vez de criar um duplicado (mesmo caminho de defesa: checagem na camada de
 * serviço ANTES do insert, com o índice único do banco como segunda linha de defesa).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'stage_measurements', schema: 'construction' },
      'idempotency_key',
      { type: Sequelize.STRING(128), allowNull: true }
    );
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX stage_measurements_idempotency_key_unique
        ON "construction"."stage_measurements" (idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);

    await queryInterface.addColumn(
      { tableName: 'material_requests', schema: 'construction' },
      'idempotency_key',
      { type: Sequelize.STRING(128), allowNull: true }
    );
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX material_requests_idempotency_key_unique
        ON "construction"."material_requests" (idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "construction"."material_requests_idempotency_key_unique";
    `);
    await queryInterface.removeColumn({ tableName: 'material_requests', schema: 'construction' }, 'idempotency_key');

    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "construction"."stage_measurements_idempotency_key_unique";
    `);
    await queryInterface.removeColumn({ tableName: 'stage_measurements', schema: 'construction' }, 'idempotency_key');
  },
};
