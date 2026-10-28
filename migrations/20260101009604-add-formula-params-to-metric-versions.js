'use strict';

/**
 * Marco 9, demanda M9-D604 (BI-008): parâmetros da fórmula que alteram o resultado numérico (por exemplo, o horizonte da
 * "necessidade para respirar") fazem parte da versão. A coluna entra no hash de reprodução (M9-D605, 3.4) e, como as demais
 * colunas da versão, fica imutável depois de publicada (o gatilho metric_versions_guard compara a linha inteira).
 * Idempotente. Faixa de migrations do BI: 9604 a 9614.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE "analytics"."metric_versions" ADD COLUMN IF NOT EXISTS formula_params jsonb NOT NULL DEFAULT '{}'::jsonb`
    );
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_versions_formula_params_object') THEN
          ALTER TABLE "analytics"."metric_versions"
            ADD CONSTRAINT metric_versions_formula_params_object CHECK (jsonb_typeof(formula_params) = 'object');
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE "analytics"."metric_versions" DROP CONSTRAINT IF EXISTS metric_versions_formula_params_object`);
    await queryInterface.sequelize.query(`ALTER TABLE "analytics"."metric_versions" DROP COLUMN IF EXISTS formula_params`);
  },
};
