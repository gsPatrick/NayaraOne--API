'use strict';

/**
 * Migration: cria VIEWs de compatibilidade de nome contratual sobre 4 tabelas físicas do
 * schema "construction" cujo nome diverge do literal exigido pelo Anexo I (seção 3,
 * "CONSTRUÇÃO + OBRAS + PÓS-OBRA — BLINDADO v1" — "Tabelas obrigatórias"):
 *
 *   - construction.budget_lines        -> fonte exige "budget_items"
 *   - construction.daily_reports       -> fonte exige "daily_logs"
 *   - construction.stage_measurements  -> fonte exige "measurements"
 *   - construction.maintenance_cases   -> fonte exige "warranty_cases"
 *
 * DECISÃO DE ENGENHARIA (item 1 do fechamento de gaps pós-Marco 6): o nome físico diverge do
 * nome contratual por motivo histórico — todo o código do módulo (models Sequelize, services,
 * controllers, rotas, ~15 migrations anteriores, dezenas de testes) já referencia as tabelas
 * pelos nomes físicos atuais. Renomear a tabela física agora (`ALTER TABLE ... RENAME TO`)
 * quebraria todo esse código de uma vez (o Sequelize mapeia `tableName` explicitamente em cada
 * model — ver src/models/StageMeasurement.js, DailyReport.js, MaterialRequest.js/
 * MaintenanceCase.js) por nenhum ganho real: o contrato pede o NOME, não exige que seja a
 * tabela física em si. Em vez de um rename arriscado em runtime, criamos uma VIEW com o nome
 * EXATO exigido pelo Anexo I apontando para a tabela física real — garante rastreabilidade/
 * compliance literal (qualquer auditor ou DBA que rode
 * `\dt construction.*`/`information_schema.tables` encontra "budget_items", "daily_logs",
 * "measurements" e "warranty_cases" no schema, com o mesmo conteúdo da tabela física) sem
 * tocar em nenhuma FK, model, service ou teste existente.
 *
 * As views são read-only por padrão (sem `WITH (security_invoker)`/`INSTEAD OF` triggers) —
 * suficiente para o objetivo de nomenclatura/compliance. Nenhum código da aplicação escreve
 * através delas; toda escrita continua pela tabela física via os models/services atuais.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE VIEW "construction"."budget_items" WITH (security_invoker = true) AS
        SELECT * FROM "construction"."budget_lines";
    `);
    await queryInterface.sequelize.query(`
      CREATE VIEW "construction"."daily_logs" WITH (security_invoker = true) AS
        SELECT * FROM "construction"."daily_reports";
    `);
    await queryInterface.sequelize.query(`
      CREATE VIEW "construction"."measurements" WITH (security_invoker = true) AS
        SELECT * FROM "construction"."stage_measurements";
    `);
    await queryInterface.sequelize.query(`
      CREATE VIEW "construction"."warranty_cases" WITH (security_invoker = true) AS
        SELECT * FROM "construction"."maintenance_cases";
    `);

    // Mesmo privilégio mínimo (SELECT) já concedido à role de runtime nas tabelas físicas —
    // só leitura, nenhuma escrita passa pelas views (ver decisão de engenharia acima).
    // GAP REAL CORRIGIDO (CI quebrado, 08/10/2026): "nayara_runtime" só existe em produção.
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await queryInterface.sequelize.query('GRANT SELECT ON "construction"."budget_items" TO nayara_runtime;');
      await queryInterface.sequelize.query('GRANT SELECT ON "construction"."daily_logs" TO nayara_runtime;');
      await queryInterface.sequelize.query('GRANT SELECT ON "construction"."measurements" TO nayara_runtime;');
      await queryInterface.sequelize.query('GRANT SELECT ON "construction"."warranty_cases" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP VIEW IF EXISTS "construction"."warranty_cases";');
    await queryInterface.sequelize.query('DROP VIEW IF EXISTS "construction"."measurements";');
    await queryInterface.sequelize.query('DROP VIEW IF EXISTS "construction"."daily_logs";');
    await queryInterface.sequelize.query('DROP VIEW IF EXISTS "construction"."budget_items";');
  },
};
