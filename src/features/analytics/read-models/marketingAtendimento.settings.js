'use strict';

/**
 * M9-D627 — parâmetro do administrador dos read models de Marketing e Atendimento (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.marketing_atendimento.janela_reconferencia_dias   quantos dias para trás a agenda (00:05 e a cada 15 min) reconfere dias e meses
 *                                                               que mudam sem evento: status de entrega que chega depois, avaliação concluída,
 *                                                               satisfação respondida, falha de automação e atendimento que vence o prazo.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const WINDOW_KEY = 'analytics.marketing_atendimento.janela_reconferencia_dias';
const MKT_ATENDIMENTO_DEFAULTS = Object.freeze({ [WINDOW_KEY]: 7 });
const MKT_ATENDIMENTO_SETTINGS_SCHEMA = { [WINDOW_KEY]: { type: 'integer', min: 1, max: 90 } };

async function readReconferenceDays(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = Number(await getSetting(WINDOW_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, MKT_ATENDIMENTO_DEFAULTS[WINDOW_KEY]));
  return Number.isInteger(value) && value >= 1 && value <= 90 ? value : MKT_ATENDIMENTO_DEFAULTS[WINDOW_KEY];
}

module.exports = { WINDOW_KEY, MKT_ATENDIMENTO_DEFAULTS, MKT_ATENDIMENTO_SETTINGS_SCHEMA, readReconferenceDays };
