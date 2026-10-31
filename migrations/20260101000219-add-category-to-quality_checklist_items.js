'use strict';

/**
 * Migration: adiciona `category` a "construction"."quality_checklist_items" (M6-12) — item de
 * checklist deixa de ser só texto livre e ganha um tipo/categoria configurável (pintura,
 * hidráulica, elétrica, etc.).
 *
 * DECISÃO DE ENGENHARIA: a fonte não lista as categorias válidas de item de qualidade de obra
 * (lacuna documental, mesmo padrão do restante do módulo — ver M6-103). Uso STRING(32) com uma
 * lista de valores válidos aplicada em `qualityChecklist.service.js` (`CATEGORIES`), em vez de
 * ENUM do Postgres, para poder adicionar categoria nova via deploy de código sem `ALTER TYPE`
 * — mesmo padrão já usado em `severity`/`status` das outras tabelas deste módulo. Categorias
 * iniciais escolhidas a partir dos ofícios de obra mais comuns citados implicitamente no
 * domínio de Construção Civil residencial/comercial do Anexo I: PINTURA, HIDRAULICA, ELETRICA,
 * ESTRUTURA, ACABAMENTO, ALVENARIA, OUTROS.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'quality_checklist_items', schema: 'construction' },
      'category',
      {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'OUTROS',
        comment: 'PINTURA|HIDRAULICA|ELETRICA|ESTRUTURA|ACABAMENTO|ALVENARIA|OUTROS',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'quality_checklist_items', schema: 'construction' }, 'category');
  },
};
