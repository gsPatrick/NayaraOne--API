'use strict';

/** Constantes do calendário unificado (M9-D801). Os 10 tipos de origem e os 3 status são os do livro; ver README. */
const SOURCE_TYPES = Object.freeze([
  'CRM_TASK', 'VISIT', 'LEGAL_DEADLINE', 'RENEWAL', 'GUARANTEE', 'BILLING', 'CONSTRUCTION', 'MAINTENANCE', 'FISCAL', 'COMMITMENT',
]);
const STATUSES = Object.freeze(['OPEN', 'DONE', 'CANCELLED']);
const SEVERITIES = Object.freeze(['INFO', 'WARNING', 'CRITICAL']);

/** Transições do status (livro, M9-D801 §3.3): reabrir é DONE/CANCELLED -> OPEN; nada vai direto entre DONE e CANCELLED. */
const STATUS_TRANSITIONS = Object.freeze({
  OPEN: ['DONE', 'CANCELLED'],
  DONE: ['OPEN'],
  CANCELLED: ['OPEN'],
});

/** Fuso do livro ("hoje 00:00 a hoje + 30 dias em America/Sao_Paulo"). */
const TIMEZONE = 'America/Sao_Paulo';
const MAX_PAGE_SIZE = 200;

module.exports = { SOURCE_TYPES, STATUSES, SEVERITIES, STATUS_TRANSITIONS, TIMEZONE, MAX_PAGE_SIZE };
