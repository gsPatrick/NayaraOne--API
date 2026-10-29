'use strict';

/**
 * M9-D624 — entrada de cada fórmula dos KPIs financeiros a partir da linha de rm_finance_health. Mapeamento puro (sem banco): datas viram
 * AAAA-MM-DD e os campos jsonb já chegam como objeto.
 */
const dateText = (value) => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
};

const INPUTS = Object.freeze({
  'fin.reconciliations_pending': (row, asOfDate) => ({
    asOfDate, count: row.pending_reconciliations, amountAbs: String(row.pending_reconciliations_amount), oldestDate: dateText(row.pending_reconciliations_oldest_date),
    byBand: row.pending_reconciliations_by_band || { labels: [], accounts: {} }, lastImportDate: dateText(row.last_statement_import_date),
  }),
  'fin.anomalies_open': (row, asOfDate) => ({
    asOfDate, byRisk: row.open_anomalies_by_risk || {}, byType: row.open_anomalies_by_type || {}, oldestDate: dateText(row.open_anomalies_oldest_date),
  }),
});

const paramsOf = (code, settings) => (code === 'fin.reconciliations_pending' ? { maxStatementAgeDays: settings.maxStatementAgeDays } : {});

module.exports = { INPUTS, paramsOf, dateText };
