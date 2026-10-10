'use strict';

/**
 * GAP REAL CORRIGIDO (auditoria de carga/limpeza de tenant de teste, 08/10/2026):
 * people.persons.merged_into_id é uma FK auto-referenciada (fusão de cadastro duplicado,
 * ver personMerge.service.js) e NUNCA teve índice — só a PK e o unique de
 * (group_id, tax_id_normalized) existiam. Qualquer DELETE em massa de persons precisa, para
 * CADA linha apagada, verificar se alguma OUTRA linha aponta pra ela via merged_into_id — sem
 * índice isso é um Seq Scan completo da tabela POR LINHA apagada (O(n²)). Medido ao vivo:
 * apagar 300.000 persons de um tenant de teste isolado levou mais de 44 minutos sem nenhum
 * outro gargalo (nenhuma outra tabela referenciando persons tinha volume relevante — todas
 * com no máximo 34 linhas reais, confirmado por auditoria). Afeta qualquer operação em massa
 * sobre persons em produção (people.persons é referenciada por CRM, Jurídico, Financeiro,
 * Obras, Estoque, Compras — todo o sistema), não só limpeza de teste.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS persons_merged_into_id_idx ON people.persons (merged_into_id) WHERE merged_into_id IS NOT NULL'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS people.persons_merged_into_id_idx');
  },
};
