'use strict';

/**
 * M9-D651 — filtro de origem (sourceRefs) dos KPIs de atrasos, medições e não conformidades para a data-base. O limite superior do período dos atrasos é
 * o INÍCIO do dia-base em São Paulo (início inclusivo, fim exclusivo): etapa com fim previsto antes dele está atrasada.
 */
const { MEASURED_STATUSES } = require('../../sourceSpecs.obras.operacao');

const dayStartIso = (asOfDate) => new Date(`${asOfDate}T00:00:00-03:00`).toISOString();

const FILTERS = Object.freeze({
  'obra.delays': (asOfDate) => ({ period: { from: null, to: dayStartIso(asOfDate) }, equals: { deletedAt: null } }),
  'obra.measurements': () => ({ status: MEASURED_STATUSES }),
  'obra.nonconformities': () => ({ equals: { deletedAt: null } }),
});

module.exports = { FILTERS, dayStartIso };
