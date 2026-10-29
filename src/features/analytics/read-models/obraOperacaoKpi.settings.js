'use strict';

/**
 * M9-D651 — parâmetros do administrador dos KPIs de Obras de atrasos, medições e não conformidades (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.obra.<código>              owner (papel responsável pela reconciliação) de delays, measurements e nonconformities; padrão do livro:
 *                                              Diretoria de Obras (papel obras-gestor). Lido na publicação do indicador (readObraOwner).
 *   analytics.qualidade.max_sem_causa_pct      parcela máxima, em %, de não conformidades sem causa informada; acima disso obra.nonconformities
 *                                              sai DEGRADED sem valor. Padrão do livro: 5.
 * Os prazos, as fórmulas e os estados dos indicadores são do livro e não são parâmetro. Arquivo sem dependência de settings.service no topo (evita ciclo);
 * a leitura usa import tardio.
 */
const { DEFAULT_OWNER } = require('./obraKpi.settings');

const OBRA_OPERACAO_KPI_CODES = Object.freeze(['obra.delays', 'obra.measurements', 'obra.nonconformities']);
const NO_CAUSE_KEY = 'analytics.qualidade.max_sem_causa_pct';
const NO_CAUSE_DEFAULT = 5;

const ownerKey = (code) => `analytics.owner.${code}`;
const OBRA_OPERACAO_DEFAULTS = Object.freeze({ ...Object.fromEntries(OBRA_OPERACAO_KPI_CODES.map((code) => [ownerKey(code), DEFAULT_OWNER])), [NO_CAUSE_KEY]: NO_CAUSE_DEFAULT });
const OBRA_OPERACAO_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(OBRA_OPERACAO_KPI_CODES.map((code) => [ownerKey(code), { type: 'string' }])),
  [NO_CAUSE_KEY]: { type: 'integer', min: 0, max: 100 },
});

async function readMaxWithoutCausePct(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = Number(await getSetting(NO_CAUSE_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, NO_CAUSE_DEFAULT));
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : NO_CAUSE_DEFAULT;
}

module.exports = { OBRA_OPERACAO_KPI_CODES, NO_CAUSE_KEY, OBRA_OPERACAO_DEFAULTS, OBRA_OPERACAO_SETTINGS_SCHEMA, readMaxWithoutCausePct };
