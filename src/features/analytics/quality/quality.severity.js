'use strict';

/**
 * M9-D696 (3.4) — severidade do livro (WARN, BLOCK) -> valor gravado em data_quality_checks.severity (INFO, WARNING, CRITICAL, constraint da
 * M9-D602): WARN = WARNING; BLOCK = CRITICAL (o "check CRITICAL" que aborta o rebuild na M9-D608). Check aprovado grava INFO.
 */
const STORED = Object.freeze({ WARN: 'WARNING', BLOCK: 'CRITICAL' });

const storedSeverity = (level) => STORED[level] || 'CRITICAL'; // nível desconhecido nunca enfraquece: vale BLOCK
const isBlocking = (stored) => stored === 'CRITICAL';

module.exports = { storedSeverity, isBlocking };
