'use strict';

/**
 * M9-D660 / M9-D611 — filtro canônico (assinado) de cada KPI do Jurídico: os registros do módulo que reproduzem o número. Os prazos abertos vão do
 * passado até antes da meia-noite de hoje+30 em São Paulo (início livre e fim exclusivo, M9-D606): vencidos, próximos 7 dias e até 30 dias. Processo
 * excluído fica fora, como nos read models; "ativo" usa a lista de encerrados do parâmetro do administrador.
 */
const { saoPauloMidnight } = require('../../period');

function legalFilterOf(code, asOfDate, settings) {
  const live = { deletedAt: null };
  const filters = {
    'legal.deadlines': { period: { from: null, to: saoPauloMidnight(asOfDate, 30).toISOString() }, status: ['PENDING'], equals: live },
    'legal.cases_by_risk': { equals: { ...live, legalFinished: settings.finishedStatuses } },
    'legal.values': { equals: { ...live, legalFinished: settings.finishedStatuses } },
    'legal.missing_documents': { status: ['PENDING'] },
  };
  return filters[code];
}

module.exports = { legalFilterOf };
