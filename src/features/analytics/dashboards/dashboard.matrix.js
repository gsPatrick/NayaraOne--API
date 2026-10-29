'use strict';

/**
 * M9-D626 (3.1 item 4) — widget de TABELA-MATRIZ: um só widget com vários indicadores em linhas x colunas (contas a pagar e a receber em 7, 30 e 60 dias:
 * 2 linhas x 3 colunas). `config.matrix` = { columns: [rótulos], rows: [{ label, metrics: [códigos, um por coluna] }] }. O widget guarda no banco o primeiro
 * indicador (a coluna `metric_code` é obrigatória nos tipos de tabela); cada célula sai com o valor pronto do endpoint de métrica (`metric`) e o seu
 * detalhe (`drilldown`). Nada é calculado aqui.
 */
const { readMetricView } = require('./dashboard.metricView');

const isMatrix = (config) => Boolean(config && config.matrix && Array.isArray(config.matrix.rows));

/** Todos os códigos de indicador que o widget lê (para buscar as definições de uma vez). */
function matrixCodes(config) {
  return isMatrix(config) ? config.matrix.rows.flatMap((r) => r.metrics) : [];
}

async function composeMatrix(ctx, widget, shared, transaction) {
  const { columns, rows } = widget.config.matrix;
  const outRows = [];
  for (const row of rows) {
    const cells = [];
    for (const [index, code] of row.metrics.entries()) {
      const cellWidget = { metric_code: code, title: `${widget.title} — ${row.label}, ${columns[index]}`, drilldown_enabled: widget.drilldown_enabled };
      const { metric, drilldown } = await readMetricView(ctx, cellWidget, shared.forMetric(code), transaction);
      cells.push({ metricCode: code, column: columns[index], title: cellWidget.title, metric, drilldown });
    }
    outRows.push({ label: row.label, cells });
  }
  return { columns, rows: outRows };
}

/** Itens da faixa de qualidade: um por célula da matriz (o indicador âncora do widget não conta duas vezes). */
function bannerViewsOf(composed) {
  return composed.flatMap((c) => {
    if (c.view && c.view.matrix) return c.view.matrix.rows.flatMap((r) => r.cells.map((cell) => ({ title: cell.title, metric: cell.metric })));
    return c.metric ? [c] : [];
  });
}

module.exports = { isMatrix, matrixCodes, composeMatrix, bannerViewsOf };
