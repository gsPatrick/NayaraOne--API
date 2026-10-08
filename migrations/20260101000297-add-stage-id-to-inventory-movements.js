'use strict';

// BUG REAL CORRIGIDO (reauditoria externa Nayara, 2026-10-08; contrato EST-004: "Material
// consumido precisa de project_id/stage_id quando atribuído à obra"): inventory.movements só
// tinha project_id — stage_id era validado na requisição (requisitions.service.js) mas nunca
// propagado pro ledger de verdade, então qualquer leitura direta de inventory.movements (o
// registro oficial do "material consumido", EST-002/EST-003) não sabia de qual ETAPA da obra o
// consumo veio, só a qual obra. Esta migration adiciona a coluna; o código em
// requisitions.service.js/counts.service.js/lossCases.service.js passa a propagar o stageId já
// validado nessas camadas pro movimento real.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'stage_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS inventory_movements_stage_id_idx
        ON "inventory"."inventory_movements" (stage_id);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "inventory"."inventory_movements_stage_id_idx";');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'stage_id');
  },
};
