'use strict';

/**
 * M9-D034 — golden dataset do sistema para NAY_COMERCIAL (ai.golden_cases, M9-D033): casos sintéticos de grounding, alucinação, seleção de tool
 * e permissão das três ferramentas do piloto, versão 1 ACTIVE, sem empresa (valem para toda empresa). Idempotente. Nenhuma tabela nova.
 * Caso do golden é imutável (gatilho AI044): o down só remove as linhas com o gatilho desligado na transação.
 */
const { semearGolden, comForcaDesligada } = require('./_helpers/aiAgentContentApply');
const comercial = require('./_helpers/aiAgentComercial');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await comForcaDesligada(q, ['ai.golden_cases'], () => semearGolden(q, comercial.AGENTE.code, comercial.GOLDEN));
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await comForcaDesligada(q, ['ai.golden_cases'], async () => {
        await q('ALTER TABLE ai.golden_cases DISABLE TRIGGER USER');
        await q("DELETE FROM ai.golden_cases WHERE company_id IS NULL AND agent_code = 'NAY_COMERCIAL' AND case_key IN (:chaves)", { chaves: comercial.GOLDEN.map((c) => c.caseKey) });
        await q('ALTER TABLE ai.golden_cases ENABLE TRIGGER USER');
      });
    });
  },
};
