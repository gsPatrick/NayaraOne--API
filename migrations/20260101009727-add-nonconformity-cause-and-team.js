'use strict';

/**
 * Marco 9, demanda M9-D618: causa e equipe da não conformidade, as dimensões de recorrência do BI de Obras (§9).
 * construction.nonconformities.cause_code e team_label são opcionais; sem valor, o read model usa 'NAO_INFORMADA' (e o score de
 * qualidade cai, M9-D652). Idempotente; a tabela já tem RLS FORCE e o ALTER TABLE não muda políticas nem GRANTs.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "construction"."nonconformities" ADD COLUMN IF NOT EXISTS cause_code varchar(64)');
    await q('ALTER TABLE "construction"."nonconformities" ADD COLUMN IF NOT EXISTS team_label varchar(120)');
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "construction"."nonconformities" DROP COLUMN IF EXISTS team_label');
    await q('ALTER TABLE "construction"."nonconformities" DROP COLUMN IF EXISTS cause_code');
  },
};
