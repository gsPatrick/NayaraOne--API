'use strict';

/**
 * M9-D712 (3.3) — tabela única e completa de criticidade das 90 métricas do BI (33 CRITICAL e 57 NORMAL), dona da semente do registry
 * (M9-D603 só entrega o registro). Métrica nova só publica no catálogo global se tiver linha aqui (3.4): `assertInCriticalityTable`
 * é chamado pela publicação global e o teste de consistência reprova o CI quando falta ou sobra linha.
 */
const AppError = require('../../../../utils/AppError');

const ROWS = Object.freeze([
  ...require('./criticality.rows.financeiro').ROWS,
  ...require('./criticality.rows.comercial').ROWS,
  ...require('./criticality.rows.locacaoObras').ROWS,
  ...require('./criticality.rows.juridicoMarketing').ROWS,
  ...require('./criticality.rows.tecnologiaIa').ROWS,
  ...require('./criticality.rows.centroComando').ROWS,
].map((row) => Object.freeze({ ...row, formulaId: `${row.code}.v1` })));

const BY_CODE = new Map(ROWS.map((row) => [row.code, row]));
if (BY_CODE.size !== ROWS.length) throw new Error('Tabela de criticidade com código duplicado.');

const getCriticalityRow = (metricCode) => BY_CODE.get(metricCode) || null;
const listCriticalityRows = () => ROWS;
const criticalCodes = () => ROWS.filter((r) => r.criticality === 'CRITICAL').map((r) => r.code);

/** 422 ANALYTICS_METRIC_NOT_IN_CRITICALITY_TABLE quando o código não tem linha na tabela. */
function assertInCriticalityTable(metricCode) {
  if (!BY_CODE.has(metricCode)) {
    throw AppError.unprocessable(
      `O indicador ${metricCode} não tem linha na tabela de criticidade; acrescente-a (CRITICAL ou NORMAL, com o motivo) antes de publicar.`,
      'ANALYTICS_METRIC_NOT_IN_CRITICALITY_TABLE', { metricCode }
    );
  }
}

/** Compara o conjunto de códigos informado com a tabela: { missing (na tabela e não no conjunto), extra (no conjunto e fora da tabela) }. */
function compareWithTable(codes) {
  const have = new Set(codes);
  return { missing: ROWS.filter((r) => !have.has(r.code)).map((r) => r.code), extra: [...have].filter((c) => !BY_CODE.has(c)).sort() };
}

module.exports = { getCriticalityRow, listCriticalityRows, criticalCodes, assertInCriticalityTable, compareWithTable };
