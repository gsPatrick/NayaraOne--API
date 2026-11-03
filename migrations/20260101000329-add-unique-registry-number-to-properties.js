'use strict';

/**
 * Migration: fecha gap real de auditoria externa (Abacus AI, 11/10/2026) — Marco 3, CRMX-003
 * ("Imóvel único"/unicidade de matrícula). Dois imóveis foram criados com a mesma matrícula
 * física (MAT-AUDIT-001) sem nenhum bloqueio — "real_estate"."properties" não tinha nenhuma
 * constraint de unicidade em registry_number, só o internal_code (código comercial) era único.
 *
 * Índice único PARCIAL em (group_id, registry_number), ignorando registry_number NULL — matrícula
 * pode legitimamente não estar cadastrada ainda (imóvel recém-criado, documentação pendente), e
 * múltiplos imóveis sem matrícula não violam CRMX-003. Escopo é por group_id (não company_id),
 * mesmo padrão de internal_code nesta tabela — uma matrícula física pertence ao grupo, não deve
 * repetir mesmo entre empresas do mesmo grupo; mas o mesmo número PODE existir em grupos
 * (tenants) diferentes, isso não é duplicidade real.
 *
 * Idempotente: só cria o índice se ele ainda não existir.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS properties_group_id_registry_number_unique
      ON real_estate.properties (group_id, registry_number)
      WHERE registry_number IS NOT NULL;
    `);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS real_estate.properties_group_id_registry_number_unique;
    `);
  },
};
