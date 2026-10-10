'use strict';

/**
 * Migration: altera "construction"."daily_reports" para suportar (Marco 6 — M6-07/M6-20/M6-58/M6-94):
 *
 *  - `shift_code` (M6-07/M6-58): chave lógica passa de `(project_id, report_date)` para
 *    `(project_id, report_date, shift_code)`, permitindo mais de um RDO por dia (ex.: turno
 *    MANHA e turno TARDE). DEFAULT 'UNICO' para não quebrar os registros já existentes
 *    (obras que só registravam 1 RDO/dia continuam válidas sob um turno "único" implícito).
 *  - `supersedes_id` (M6-20): correção de um RDO já existente NUNCA sobrescreve a linha
 *    original — gera uma NOVA linha apontando pra qual registro ela corrige/substitui. A
 *    consulta de "diário atual" segue a cadeia até a revisão mais recente
 *    (`dailyReports.service.js:getCurrentDailyReport`).
 *  - `client_local_id` / `idempotency_key` (M6-94): suporte a captura offline pelo app —
 *    o app gera um ID local ao criar o registro offline; ao sincronizar, envia
 *    `idempotencyKey` (UNIQUE quando presente) pra evitar duplicar o mesmo RDO se a
 *    sincronização for reenviada.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE "construction"."daily_reports" DROP CONSTRAINT IF EXISTS daily_reports_project_date_unique;
    `);

    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'shift_code',
      { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'UNICO' }
    );

    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'supersedes_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'daily_reports', schema: 'construction' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );

    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'client_local_id',
      { type: Sequelize.STRING(128), allowNull: true }
    );

    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'idempotency_key',
      { type: Sequelize.STRING(128), allowNull: true }
    );

    // Índice único PARCIAL (só sobre `supersedes_id IS NULL`, ou seja, sobre a linha "raiz" de
    // cada cadeia de revisões): garante a chave lógica (project_id, report_date, shift_code)
    // igual à spec (M6-07/M6-58), mas sem impedir que uma correção (M6-20, append-only) crie
    // uma nova linha com a MESMA chave lógica apontando via `supersedes_id` pro registro
    // anterior — se fosse um UNIQUE comum, a própria correção violaria a constraint.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX daily_reports_project_date_shift_unique
        ON "construction"."daily_reports" (project_id, report_date, shift_code)
        WHERE supersedes_id IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX daily_reports_idempotency_key_unique
        ON "construction"."daily_reports" (idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "construction"."daily_reports_idempotency_key_unique";
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "construction"."daily_reports_project_date_shift_unique";
    `);
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'idempotency_key');
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'client_local_id');
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'supersedes_id');
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'shift_code');
    await queryInterface.sequelize.query(`
      ALTER TABLE "construction"."daily_reports" ADD CONSTRAINT daily_reports_project_date_unique UNIQUE (project_id, report_date);
    `);
  },
};
