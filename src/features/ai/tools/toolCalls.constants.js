'use strict';

/** Constantes das chamadas de ferramenta da NAY (M9-D006). Os valores seguem o livro; a máquina é a mesma do gatilho do banco. */
const STATUSES = Object.freeze(['REQUESTED', 'VALIDATED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'PROPOSED', 'CANCELLED_BY_HUMAN']);
const FINAL_STATUSES = Object.freeze(['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED_BY_HUMAN']);
const TRANSITIONS = Object.freeze({
  REQUESTED: ['VALIDATED', 'BLOCKED'],
  VALIDATED: ['EXECUTING', 'PROPOSED', 'BLOCKED'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'BLOCKED'],
  PROPOSED: ['SUCCEEDED', 'FAILED', 'CANCELLED_BY_HUMAN', 'BLOCKED'],
});
/** Estados que significam "ainda em andamento": a mesma chamada repetida recebe 409. */
const IN_PROGRESS = Object.freeze(['REQUESTED', 'VALIDATED', 'EXECUTING']);

/** Decisão humana da recomendação (D019/D007) -> estado da chamada. */
const PROPOSAL_OUTCOMES = Object.freeze({
  EXECUTED: { status: 'SUCCEEDED' },
  EXECUTION_FAILED: { status: 'FAILED' },
  REJECTED: { status: 'CANCELLED_BY_HUMAN' },
  STALE: { status: 'BLOCKED', blockedReason: 'STALE' },
});

const EVENT_BLOCKED = 'ai.tool_call.blocked';
const SENSITIVE_MARK = '[REDIGIDO:sensivel]';

module.exports = { STATUSES, FINAL_STATUSES, TRANSITIONS, IN_PROGRESS, PROPOSAL_OUTCOMES, EVENT_BLOCKED, SENSITIVE_MARK };
