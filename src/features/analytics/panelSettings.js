'use strict';

/**
 * M9-D626 — parâmetros do administrador do painel Financeiro (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.painel.financeiro.limiar_conciliacoes_pendentes   o cartão de conciliações pendentes acende o alerta quando o número é MAIOR que este
 *   analytics.painel.financeiro.limiar_anomalias_abertas        o cartão de anomalias abertas acende o alerta quando o número é MAIOR que este
 * Valem só enquanto NÃO existe alerta publicado para o indicador: com alerta publicado (limite simples), o limiar e o operador dele mandam (livro: "acima
 * do limiar do alerta publicado"). Padrão 0 (qualquer pendência ou anomalia aberta acende), o mais conservador.
 */
const CONCILIACOES_KEY = 'analytics.painel.financeiro.limiar_conciliacoes_pendentes';
const ANOMALIAS_KEY = 'analytics.painel.financeiro.limiar_anomalias_abertas';

const PANEL_SETTING_DEFAULTS = Object.freeze({ [CONCILIACOES_KEY]: 0, [ANOMALIAS_KEY]: 0 });
const PANEL_SETTINGS_SCHEMA = {
  [CONCILIACOES_KEY]: { type: 'integer', min: 0, max: 1000000 },
  [ANOMALIAS_KEY]: { type: 'integer', min: 0, max: 1000000 },
};

async function readPanelSetting(key, ctx, transaction) {
  const { getSetting } = require('../settings/settings.service'); // import tardio: evita ciclo com o serviço de parâmetros
  const value = Number(await getSetting(key, { companyId: ctx.companyId, groupId: ctx.groupId }, transaction, PANEL_SETTING_DEFAULTS[key]));
  return Number.isInteger(value) && value >= 0 ? value : PANEL_SETTING_DEFAULTS[key];
}

module.exports = { CONCILIACOES_KEY, ANOMALIAS_KEY, PANEL_SETTING_DEFAULTS, PANEL_SETTINGS_SCHEMA, readPanelSetting };
