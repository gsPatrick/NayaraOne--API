'use strict';

/**
 * Marco 9, demanda M9-D671 (KPIs de Marketing: opt-out): rm_mkt_optout_month, por mês de São Paulo e canal, os contatos alcançados (pessoas distintas
 * que receberam mensagem de automação ou campanha aceita pelo provedor) e os pedidos de saída (pessoas ou endereços distintos com opt-out registrado no
 * mês). O distinto por mês não se obtém somando dias, por isso o mês é o agregado. Só ids e contagens. Colunas:
 *   reached    contatos alcançados no mês e canal
 *   opt_outs   pedidos de saída no mês e canal (suppression_list OPT_OUT mais communication_consents OPT_OUT, sem repetir a pessoa)
 *   undated    pedidos de saída sem data (empresa inteira; regra de qualidade: DEGRADED)
 * RLS ENABLE + FORCE e GRANT ao nayara_runtime com guarda de existência (apoio _helpers/analyticsReadModelTables). Idempotente.
 */
const { COUNT, createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const TABLE = {
  name: 'rm_mkt_optout_month',
  key: ['month', 'channel'],
  columns: ['month varchar(7) NOT NULL CHECK (month ~ \'^[0-9]{4}-(0[1-9]|1[0-2])$\')', 'channel varchar(16) NOT NULL', COUNT('reached'), COUNT('opt_outs'), COUNT('undated')],
};

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE SCHEMA IF NOT EXISTS "analytics"');
    await createReadModelTable(q, TABLE);
    await grantRuntime(q, [TABLE.name]);
  },

  down: async (queryInterface) => dropTables((sql) => queryInterface.sequelize.query(sql), [TABLE.name]),
};
