'use strict';

/**
 * M9-D710 / M9-D611 — filtro canônico (assinado) de cada KPI de fatos do dia: os registros do read model que reproduzem o número. Janela [de, até) em instantes (início inclusivo,
 * fim exclusivo, M9-D606) e, nos pagamentos, o limiar relevante como flag. O detalhe (drill-down) lista os fatos vivos da janela (originais não revertidos).
 */
const { windowOf } = require('./windows');

function commandFilterOf(code, asOfDate, settings) {
  const win = windowOf(asOfDate, settings.now, settings.hours);
  const period = { from: win.from.toISOString(), to: win.to.toISOString() };
  if (code === 'fin.payments_settled_relevant') return { period, equals: { relevantFrom: settings.threshold } };
  return { period };
}

module.exports = { commandFilterOf };
