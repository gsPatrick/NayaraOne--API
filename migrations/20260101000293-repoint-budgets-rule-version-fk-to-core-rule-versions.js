'use strict';

/**
 * Migration: termina a migração de margem mínima de obra pro Motor de Regras genérico
 * (ver marginRules.service.js, REG-OBR-001). A FK física de `construction.budgets.rule_
 * version_id` ainda apontava para `construction.margin_rules` (tabela antiga, mantida só como
 * espelho de compatibilidade com mesmo UUID da RuleVersion real). Redireciona a FK pra
 * `core.rule_versions`, a fonte da verdade real — depois disso o espelho em margin_rules deixa
 * de ser estruturalmente necessário (mas é inofensivo deixá-lo, não removido aqui pra não
 * quebrar nada que ainda leia dele incidentalmente).
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'ALTER TABLE construction.budgets DROP CONSTRAINT budgets_rule_version_id_fkey;'
    );
    await queryInterface.sequelize.query(`
      ALTER TABLE construction.budgets
        ADD CONSTRAINT budgets_rule_version_id_fkey
        FOREIGN KEY (rule_version_id) REFERENCES core.rule_versions(id)
        ON DELETE RESTRICT ON UPDATE CASCADE;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'ALTER TABLE construction.budgets DROP CONSTRAINT budgets_rule_version_id_fkey;'
    );
    await queryInterface.sequelize.query(`
      ALTER TABLE construction.budgets
        ADD CONSTRAINT budgets_rule_version_id_fkey
        FOREIGN KEY (rule_version_id) REFERENCES construction.margin_rules(id)
        ON DELETE RESTRICT ON UPDATE CASCADE;
    `);
  },
};
