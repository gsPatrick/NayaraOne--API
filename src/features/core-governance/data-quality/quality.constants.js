'use strict';

/** Enumerações da qualidade de cadastro (M9-D806). São valores de domínio, não códigos de erro. */
const DIMENSIONS = Object.freeze({ COMPLETENESS: 'COMPLETENESS', CONSISTENCY: 'CONSISTENCY' });
const SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const ISSUE_STATUS = Object.freeze({ OPEN: 'OPEN', RESOLVED: 'RESOLVED' });
const EVENT_ISSUE_OPENED = 'data.quality.issue.opened';
const SEVERITY_RANK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });

/** Linhas lidas por lote na varredura e nas listas. */
const SCAN_BATCH = 200;

module.exports = { DIMENSIONS, SEVERITIES, ISSUE_STATUS, EVENT_ISSUE_OPENED, SEVERITY_RANK, SCAN_BATCH };
