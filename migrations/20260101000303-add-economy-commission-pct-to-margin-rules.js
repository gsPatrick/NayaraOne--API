'use strict';

/**
 * Migration (auditoria externa Nayara, fechamento Marco 6 — TAREFA 2): o módulo de Obras só
 * tinha regra de margem mínima (`min_margin_pct`, REG-OBR-001 — ver marginRules.service.js).
 * A auditoria pede também "economia" (economia mínima esperada da obra frente ao orçado) e
 * "comissão" (comissão sobre a obra) como regras configuráveis, mesmo padrão de versionamento
 * imutável já usado para a margem mínima.
 *
 * `construction.margin_rules` hoje é só um ESPELHO de compatibilidade de FK (a fonte real da
 * verdade é `core.rule_versions.action_json`, ver decisão de engenharia no topo de
 * marginRules.service.js) — mas o espelho precisa carregar os mesmos campos pra continuar
 * sendo uma cópia fiel da versão publicada (auditoria/consulta direta na tabela, se alguém
 * precisar, bate com o que está no Motor de Regras).
 *
 * Guard de `nayara_runtime`: mesmo padrão das migrations mais recentes do schema `construction`
 * — o runtime não precisa de GRANT extra pra ALTER TABLE/ADD COLUMN simples (sem criar
 * tabela/sequence nova), mas mantemos o guard idempotente por padrão do repositório.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'margin_rules', schema: 'construction' },
      'economy_pct',
      { type: Sequelize.DECIMAL(5, 2), allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'margin_rules', schema: 'construction' },
      'commission_pct',
      { type: Sequelize.DECIMAL(5, 2), allowNull: true }
    );

    const [[{ exists: runtimeRoleExists } = { exists: false }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeRoleExists) {
      await queryInterface.sequelize.query(
        'GRANT SELECT, INSERT, UPDATE ON "construction"."margin_rules" TO nayara_runtime;'
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'margin_rules', schema: 'construction' }, 'commission_pct');
    await queryInterface.removeColumn({ tableName: 'margin_rules', schema: 'construction' }, 'economy_pct');
  },
};
