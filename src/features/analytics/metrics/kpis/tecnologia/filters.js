'use strict';

/**
 * M9-D680 / M9-D611 — filtro canônico (assinado) de cada KPI de Tecnologia: os registros que reproduzem o número. Disponibilidade, autenticação e bloqueios usam o próprio read model
 * da empresa (o sinal técnico é global e a cópia por empresa é a origem com `company_id`, DI-D628-1): disponibilidade no mês de São Paulo até a data-base, autenticação e bloqueios no dia.
 * Filas: itens do outbox aguardando. Integrações: a última janela fechada de cada connection ativa na janela configurada (flag tecWindow). Freshness: atualizações bem-sucedidas dos read models.
 */
const dates = require('../../period.dates');

const monthStart = (day) => `${day.slice(0, 7)}-01`;

function techFilterOf(code, asOfDate, settings) {
  const tomorrow = dates.addDays(asOfDate, 1);
  const filters = {
    'tec.availability': { period: { from: monthStart(asOfDate), to: tomorrow } },
    'tec.queues_dlq': { status: ['PENDING'] },
    'tec.integration_errors': { equals: { tecWindow: settings.windowMinutes } },
    'tec.freshness': { status: ['SUCCEEDED', 'DEGRADED'] },
    'tec.auth_failures': { period: { from: asOfDate, to: tomorrow } },
    'tec.blocked_events': { period: { from: asOfDate, to: tomorrow } },
  };
  return filters[code];
}

module.exports = { techFilterOf };
