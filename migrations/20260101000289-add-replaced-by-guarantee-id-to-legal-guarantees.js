'use strict';

/**
 * Migration: auditoria externa (contrato bruto, Anexo I "9. Garantias locatícias") —
 * "Garantia vencendo gera tarefas/eventos; contrato não perde histórico quando a garantia é
 * substituída." Até aqui, substituir uma garantia (ex.: trocar fiador por seguro-fiança)
 * significava UPDATE/soft-delete da linha antiga sem nenhum vínculo explícito com a nova — o
 * histórico ficava espalhado (duas linhas em legal.guarantees do mesmo contrato, sem relação
 * nenhuma entre elas, indistinguível de "cadastro duplicado por engano"). Esta coluna cria o
 * vínculo explícito: a garantia antiga nunca é apagada, só marcada com `replaced_by_guarantee_id`
 * apontando para a nova (ver guarantees.service.js#replaceGuarantee).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'guarantees', schema: 'legal' },
      'replaced_by_guarantee_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'guarantees', schema: 'legal' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'guarantees', schema: 'legal' }, 'replaced_by_guarantee_id');
  },
};
