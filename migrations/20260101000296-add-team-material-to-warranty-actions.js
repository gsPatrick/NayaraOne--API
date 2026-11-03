'use strict';

/**
 * Migration (auditoria pós-Marco 6, item 2): o dashboard de pós-obra (dashboard.service.js)
 * só conseguia quebrar recorrência de ação de garantia por causa (`rootCauseCode`, campo da
 * tabela `maintenance_cases`) — o caderno de BI (seção 9, "KPIs Obras") pede recorrência por
 * causa/equipe/material, e `construction.warranty_actions` não tinha campo nenhum pra equipe
 * nem material usado na ação (comentário explícito em dashboard.service.js admitindo a lacuna).
 *
 * Não existe tabela de "equipe"/"time" no schema atual (buscado em todo o diretório migrations/
 * — só há usuário individual via `performed_by_user_id`), então `assigned_team` é texto livre
 * (igual ao padrão já usado pra `shift_code`/labels em outras tabelas de construção), não FK —
 * não inventa uma entidade de domínio "Team" que o contrato não define. `material_used` também
 * é texto livre: a ação de garantia pode usar material do estoque (já rastreado por
 * `inventory_movements`, sem vínculo com warranty_action) ou material avulso de terceiro, então
 * um campo descritivo simples atende o pedido de BI sem forçar um vínculo de estoque que o
 * contrato não exige aqui.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'warranty_actions', schema: 'construction' },
      'assigned_team',
      { type: Sequelize.STRING(120), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'warranty_actions', schema: 'construction' },
      'material_used',
      { type: Sequelize.STRING(255), allowNull: true }
    );

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS warranty_actions_assigned_team_idx
        ON "construction"."warranty_actions" (assigned_team);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "construction"."warranty_actions_assigned_team_idx";');
    await queryInterface.removeColumn({ tableName: 'warranty_actions', schema: 'construction' }, 'material_used');
    await queryInterface.removeColumn({ tableName: 'warranty_actions', schema: 'construction' }, 'assigned_team');
  },
};
