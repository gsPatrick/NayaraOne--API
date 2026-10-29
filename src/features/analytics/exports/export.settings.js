'use strict';

/**
 * M9-D701 — parâmetros do administrador da exportação do BI (aba "BI e Centro de Comando" em /painel/configuracoes). Dicionário em
 * SETTINGS_SCHEMA (settings.service.js faz o spread) + leitura por `readExportParams`. Padrões: Maturacao/demandas/parametros.csv.
 *
 *  analytics.export.limite_linhas_alto_risco   acima disso a exportação é de ALTO RISCO (exige MFA recente); é o que define "export massivo" (padrão 1.000)
 *  analytics.export.validade_horas             quanto tempo o arquivo pronto fica disponível antes de expirar e ser apagado (padrão 24 h)
 *  analytics.export.url_minutos                validade do endereço assinado de download (padrão 15 min)
 *  analytics.export.max_linhas                 teto de linhas de um arquivo; acima disso o pedido falha (nunca trunca em silêncio) (padrão 50.000)
 *  analytics.export.timeout_execucao_minutos   quanto tempo um job pode ficar em andamento antes de ser dado como falho (worker que morreu) (padrão 30)
 */
const KEYS = Object.freeze({
  riskRows: 'analytics.export.limite_linhas_alto_risco',
  validityHours: 'analytics.export.validade_horas',
  urlMinutes: 'analytics.export.url_minutos',
  maxRows: 'analytics.export.max_linhas',
  runTimeoutMinutes: 'analytics.export.timeout_execucao_minutos',
});
const DEFAULTS = Object.freeze({ [KEYS.riskRows]: 1000, [KEYS.validityHours]: 24, [KEYS.urlMinutes]: 15, [KEYS.maxRows]: 50000, [KEYS.runTimeoutMinutes]: 30 });

const EXPORT_SETTINGS_SCHEMA = {
  [KEYS.riskRows]: { type: 'integer', min: 1, max: 1000000 },
  [KEYS.validityHours]: { type: 'integer', min: 1, max: 720 },
  [KEYS.urlMinutes]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.maxRows]: { type: 'integer', min: 1, max: 1000000 },
  [KEYS.runTimeoutMinutes]: { type: 'integer', min: 1, max: 1440 },
};

const positive = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) >= 1 ? Number(value) : fallback);

/** { riskRows, validityHours, urlMinutes, maxRows, runTimeoutMinutes } vigentes da empresa; ausente ou inválido cai no padrão do livro. */
async function readExportParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service'); // import tardio: settings.service importa este arquivo
  const read = async (key) => positive(await getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, DEFAULTS[key]), DEFAULTS[key]);
  return {
    riskRows: await read(KEYS.riskRows), validityHours: await read(KEYS.validityHours), urlMinutes: await read(KEYS.urlMinutes),
    maxRows: await read(KEYS.maxRows), runTimeoutMinutes: await read(KEYS.runTimeoutMinutes),
  };
}

module.exports = { KEYS, DEFAULTS, EXPORT_SETTINGS_SCHEMA, readExportParams };
