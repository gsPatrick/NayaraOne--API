'use strict';

/** M9-D680 — entrada de cada fórmula dos KPIs de Tecnologia a partir das linhas dos read models (rows) e dos parâmetros (settings). Mapeamento puro (sem banco): a fórmula faz a conta em decimal exato. */
const INPUTS = Object.freeze({
  'tec.availability': (r, ctx) => ({ rows: r.availability, probes: ctx.settings.probes }),
  'tec.queues_dlq': (r) => ({ rows: r.queues, measurementAgeMinutes: r.measurementAgeMinutes }),
  'tec.integration_errors': (r) => ({ rows: r.integrations }),
  'tec.freshness': (r) => ({ rows: r.freshness }),
  'tec.auth_failures': (r) => ({ rows: r.auth, hasLog: r.hasLog }),
  'tec.blocked_events': (r) => ({ rows: r.blocked }),
});

/** Parâmetros que cada fórmula lê dos parâmetros do administrador. */
const PARAMS = Object.freeze({
  'tec.availability': (s) => ({ intervalS: s.probeIntervalS, maxMissingPct: s.missingProbesMaxPct }),
  'tec.queues_dlq': (s) => ({ staleMinutes: s.queueStaleMinutes }),
  'tec.auth_failures': (s) => ({ peakPerHour: s.authPerHour }),
  'tec.blocked_events': (s) => ({ knownReasons: s.knownBlockReasons }),
});

module.exports = { INPUTS, PARAMS };
