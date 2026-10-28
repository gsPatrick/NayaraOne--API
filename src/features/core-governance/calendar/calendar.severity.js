'use strict';

/** Severidade do item pela fonte, conforme o mapa configurado (parseSeverityMap). Fonte fora do mapa é INFO. */
function severityFor(sourceType, severityMap) {
  return (severityMap && severityMap[sourceType]) || 'INFO';
}

module.exports = { severityFor };
