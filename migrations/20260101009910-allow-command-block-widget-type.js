'use strict';

/**
 * Marco 9, demanda M9-D685: o tipo de widget COMMAND_BLOCK (um dos seis blocos do Centro de Comando) passa a ser aceito em analytics.dashboard_widgets. Só troca a
 * CHECK `dashboard_widgets_type_valid`; nenhuma tabela nova (a RLS ENABLE + FORCE e os GRANTs da 9601 continuam). A tabela é imutável por gatilho para definição
 * publicada, mas o gatilho não olha a CHECK. Idempotente e reversível (o down só volta se nenhum widget COMMAND_BLOCK existir). Faixa do grupo BI: 9910 a 9917.
 */
const T = '"analytics"."dashboard_widgets"';
const BASE = ['KPI_CARD', 'TREND', 'TABLE', 'BAR', 'LIST_ALERTS', 'QUALITY_BANNER', 'BRIEF'];
const list = (items) => items.map((t) => `'${t}'`).join(', ');

async function setTypes(queryInterface, types) {
  const q = (sql) => queryInterface.sequelize.query(sql);
  await q(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS dashboard_widgets_type_valid`);
  await q(`ALTER TABLE ${T} ADD CONSTRAINT dashboard_widgets_type_valid CHECK (widget_type IN (${list(types)}))`);
}

module.exports = {
  up: async (queryInterface) => setTypes(queryInterface, [...BASE, 'COMMAND_BLOCK']),
  down: async (queryInterface) => {
    const [[row]] = await queryInterface.sequelize.query(`SELECT count(*)::int AS n FROM ${T} WHERE widget_type = 'COMMAND_BLOCK'`);
    if (row.n > 0) throw new Error('Existem widgets COMMAND_BLOCK: desfaça antes a migration 20260101009911 (conteúdo do Centro de Comando).');
    await setTypes(queryInterface, BASE);
  },
};
