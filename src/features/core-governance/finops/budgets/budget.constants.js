'use strict';

/** Constantes dos orçamentos de custo (M9-D861). Os limiares e o período mensal são do livro (Caderno §8): não são parâmetro. */
const THRESHOLDS = Object.freeze([50, 75, 90, 100]);
const PERIOD = 'MONTH';
const EVENT_THRESHOLD = 'finops.budget.threshold';
const AUDIT_ENTITY = 'governance.budget';

module.exports = { THRESHOLDS, PERIOD, EVENT_THRESHOLD, AUDIT_ENTITY };
