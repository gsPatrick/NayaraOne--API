'use strict';

/**
 * ACHADO REAL (revalidação Claude Browser, Marco 7, 14/10/2026, N2): "due_at" em
 * inventory.tool_loans era DATE (timestamptz) — o front manda uma data pura ("2026-10-01") via
 * <input type="date">, o Postgres grava como meia-noite UTC, e ao exibir de volta o navegador
 * converte pro fuso local (America/Bahia, UTC-3), mostrando o dia ANTERIOR ("30/09/2026"). Mesma
 * classe de bug já corrigida em Seguros (F12, commit 16de631). Corrige trocando a coluna pra DATE
 * sem componente de hora (DATEONLY no Sequelize) — nunca sofre conversão de fuso.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      'ALTER TABLE "inventory"."tool_loans" ALTER COLUMN "due_at" TYPE date USING "due_at"::date;'
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      'ALTER TABLE "inventory"."tool_loans" ALTER COLUMN "due_at" TYPE timestamptz USING "due_at"::timestamptz;'
    );
  },
};
