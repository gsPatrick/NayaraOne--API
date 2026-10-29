'use strict';

/**
 * M9-D037 e M9-D038 — up e down das migrations que dão conteúdo a um agente do padrão do sistema (conteúdo + golden dataset). Cada
 * migration passa o módulo do agente (`{ AGENTE, GOLDEN }`). O down devolve a linha ao seed vazio da M9-D004 e remove os casos do golden.
 */
const { aplicarAgente, semearGolden, comForcaDesligada } = require('./aiAgentContentApply');
const { AGENTES, linhasDoSeed } = require('./aiAgentsSeed');

const TABELAS = ['ai.agents', 'ai.agent_tools', 'ai.golden_cases'];

function migrationDoAgente({ AGENTE, GOLDEN }) {
  return {
    async up(queryInterface) {
      const sequelize = queryInterface.sequelize;
      await sequelize.transaction(async (transaction) => {
        const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
        await comForcaDesligada(q, TABELAS, async () => {
          await aplicarAgente(q, AGENTE);
          await semearGolden(q, AGENTE.code, GOLDEN);
        });
      });
    },

    async down(queryInterface) {
      const sequelize = queryInterface.sequelize;
      await sequelize.transaction(async (transaction) => {
        const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
        await comForcaDesligada(q, TABELAS, async () => {
          const [rows] = await q("SELECT id FROM ai.agents WHERE company_id IS NULL AND code = :code AND version = 1 AND status = 'DRAFT'", { code: AGENTE.code });
          if (rows.length) {
            const base = linhasDoSeed().find((l) => l.code === AGENTE.code);
            const [, purpose, criticality] = AGENTES.find(([c]) => c === AGENTE.code);
            await q('DELETE FROM ai.agent_tools WHERE agent_id = :id', { id: rows[0].id });
            await q(
              `UPDATE ai.agents SET purpose = :purpose, system_policy = '', model_policy = '{}'::jsonb, data_scopes = '[]'::jsonb, limits = '{}'::jsonb, criticality = :criticality, config_hash = :hash WHERE id = :id`,
              { id: rows[0].id, purpose, criticality, hash: base.configHash }
            );
          }
          // Caso do golden é imutável (gatilho AI044): só sai com o gatilho desligado dentro desta transação.
          await q('ALTER TABLE ai.golden_cases DISABLE TRIGGER USER');
          await q("DELETE FROM ai.golden_cases WHERE company_id IS NULL AND agent_code = :code AND case_key IN (:chaves)", { code: AGENTE.code, chaves: GOLDEN.map((c) => c.caseKey) });
          await q('ALTER TABLE ai.golden_cases ENABLE TRIGGER USER');
        });
      });
    },
  };
}

module.exports = { migrationDoAgente };
