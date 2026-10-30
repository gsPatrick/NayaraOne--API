'use strict';

/**
 * Marco 9, M9-D228 — financiamento com a promotora fora.
 *  - correspondent.financing_cases.provider_history (jsonb): o histórico das trocas de provider do caso ({ from, to, at, reason, dispatchId }), para preservar o provider
 *    original quando o envio segue por um alternativo elegível ou pelo fluxo manual; a comissão continua a do provider contratado (o primeiro `from`).
 *  - correspondent.financing_cases.provider_exclusive (boolean): o caso tem exclusividade contratual com a promotora e NÃO pode ser enviado a outro provider automático.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "correspondent"."financing_cases"
      ADD COLUMN IF NOT EXISTS provider_history jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS provider_exclusive boolean NOT NULL DEFAULT false;`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE "correspondent"."financing_cases" DROP COLUMN IF EXISTS provider_exclusive, DROP COLUMN IF EXISTS provider_history;');
  },
};
