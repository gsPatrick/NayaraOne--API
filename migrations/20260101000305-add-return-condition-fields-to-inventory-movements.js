'use strict';

/**
 * GAP 2 (fechamento de auditoria externa Nayara, Marco 6): "Conferência detalhada dos
 * movimentos e custos de devolução" + "Reaproveitamento de materiais" — o movimento RETURN já
 * existia (materialRequests.service.js#returnMaterialRequest), mas não tinha como registrar
 * SE o material devolvido é reaproveitável, em que condição ele voltou, nem um custo de
 * devolução distinto do custo original do item (ex.: perda parcial de valor por dano).
 *
 * Adiciona 3 colunas opcionais em "inventory"."inventory_movements" (nulas para todo movimento
 * que não for RETURN — nenhuma migração de dado necessária nos milhares de IN/OUT/TRANSFER já
 * existentes):
 *   - reusable (boolean, default true): material devolvido pode voltar ao estoque normal
 *     (true) ou está marcado para descarte/avaliação (false).
 *   - condition_code (string curto): 'REUSABLE'|'DAMAGED'|'LOST' — condição em que o material
 *     voltou, decidida por quem confere a devolução.
 *   - return_cost (numeric(18,2)): custo de devolução, DISTINTO do custo original do item
 *     (inventory_items.average_cost) — ex.: quando condition_code='DAMAGED', o custo de
 *     devolução pode ser menor que o custo original (perda de valor), documentado aqui mesmo
 *     que seja 0 por padrão.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'reusable',
      { type: Sequelize.BOOLEAN, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'condition_code',
      { type: Sequelize.STRING(16), allowNull: true, comment: "REUSABLE|DAMAGED|LOST — só para movimentos RETURN." }
    );
    await queryInterface.addColumn(
      { tableName: 'inventory_movements', schema: 'inventory' },
      'return_cost',
      { type: Sequelize.DECIMAL(18, 2), allowNull: true, comment: 'Custo de devolução — distinto do custo original do item (inventory_items.average_cost).' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'return_cost');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'condition_code');
    await queryInterface.removeColumn({ tableName: 'inventory_movements', schema: 'inventory' }, 'reusable');
  },
};
