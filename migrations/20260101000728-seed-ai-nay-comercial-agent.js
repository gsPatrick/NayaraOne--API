'use strict';

/**
 * M9-D034 — conteúdo do agente NAY_COMERCIAL no padrão do sistema (versão 1, DRAFT, desabilitada): propósito, política, escopos de dados,
 * limites (max_tool_calls_por_run = 4), criticidade NON_CRITICAL e a allowlist com as três tools de leitura do piloto (nenhuma de escrita).
 * O hash de configuração é o mesmo da aplicação. Nenhuma tabela nova (ai.agents e ai.agent_tools já têm RLS FORCE da migration 701);
 * GRANTs não mudam. O down devolve a linha ao seed vazio da M9-D004.
 */
const { aplicarAgente, comForcaDesligada } = require('./_helpers/aiAgentContentApply');
const { AGENTES, linhasDoSeed } = require('./_helpers/aiAgentsSeed');
const comercial = require('./_helpers/aiAgentComercial');

const TABELAS = ['ai.agents', 'ai.agent_tools'];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await comForcaDesligada(q, TABELAS, () => aplicarAgente(q, comercial.AGENTE));
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await comForcaDesligada(q, TABELAS, async () => {
        const code = comercial.AGENTE.code;
        const [rows] = await q("SELECT id FROM ai.agents WHERE company_id IS NULL AND code = :code AND version = 1 AND status = 'DRAFT'", { code });
        if (!rows.length) return;
        const base = linhasDoSeed().find((l) => l.code === code);
        const [original] = AGENTES.filter(([c]) => c === code);
        await q('DELETE FROM ai.agent_tools WHERE agent_id = :id', { id: rows[0].id });
        await q(
          `UPDATE ai.agents SET purpose = :purpose, system_policy = '', model_policy = '{}'::jsonb, data_scopes = '[]'::jsonb, limits = '{}'::jsonb, criticality = :criticality, config_hash = :hash WHERE id = :id`,
          { id: rows[0].id, purpose: original[1], criticality: original[2], hash: base.configHash }
        );
      });
    });
  },
};
