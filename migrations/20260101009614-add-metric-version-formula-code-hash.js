'use strict';

/**
 * Marco 9, demanda M9-D614 (regra 4 do "Não improvisar", Guia §14): `analytics.metric_versions.formula_code_hash` guarda o SHA-256 do
 * ARQUIVO da fórmula no momento da publicação da versão. O CI compara esse hash com o arquivo atual: se o código da fórmula mudou sem
 * uma nova versão publicada, o guarda reprova ("Fórmula alterada sem nova versão: publique a v2"). Versão publicada nunca é alterada
 * (gatilho da M9-D600), então a coluna só é preenchida na publicação. Idempotente. Faixa de migrations do BI: 9604 a 9614.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "analytics"."metric_versions" ADD COLUMN IF NOT EXISTS formula_code_hash char(64) NULL');
    await q('ALTER TABLE "analytics"."metric_versions" DROP CONSTRAINT IF EXISTS metric_versions_formula_code_hash_format');
    await q(`ALTER TABLE "analytics"."metric_versions" ADD CONSTRAINT metric_versions_formula_code_hash_format
             CHECK (formula_code_hash IS NULL OR formula_code_hash ~ '^[0-9a-f]{64}$')`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE "analytics"."metric_versions" DROP COLUMN IF EXISTS formula_code_hash');
  },
};
