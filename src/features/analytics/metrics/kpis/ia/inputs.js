'use strict';

/** M9-D681 — entrada de cada fórmula dos KPIs de IA a partir das linhas dos read models (rows) e dos parâmetros (settings). Mapeamento puro (sem banco): a fórmula faz a conta em decimal exato. */
const INPUTS = Object.freeze({
  'ai.cost_by_agent': (r) => ({ rows: r.cost }),
  'ai.quality_scores': (r) => ({ rows: r.quality, week: r.week }),
  'ai.budget': (r) => ({ rows: r.cost, dayOfMonth: r.dayOfMonth, daysInMonth: r.daysInMonth }),
  'ai.tool_calls_blocked': (r) => ({ rows: r.tools }),
});

/** Parâmetros que cada fórmula lê dos parâmetros do administrador. */
const PARAMS = Object.freeze({
  'ai.quality_scores': (s) => ({ minSample: s.minSample }),
  'ai.budget': (s) => ({ alertPct: s.alertBudgetPct }),
  'ai.tool_calls_blocked': (s) => ({ knownReasons: s.knownBlockReasons }),
});

module.exports = { INPUTS, PARAMS };
