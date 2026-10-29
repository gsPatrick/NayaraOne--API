'use strict';

/**
 * Constantes do framework de contingência das integrações (Marco 9, M9-D226). Os seis modos são os da seção 18 do livro; o modo
 * padrão de cada família é o que o livro descreve (IDENTITY reutiliza PRESERVE_AND_ALTERNATE_FLOW, M9-D242). Família sem linha aqui
 * (HIGH, MEDIUM ou LOW sem caso na seção 18) usa só a fila e a nova tentativa de M9-D214 e M9-D216 e não tem modo de contingência.
 */
const MODES = Object.freeze([
  'QUEUE_AND_ALTERNATE', 'KEEP_INTERNAL_AND_REPROCESS', 'PRESERVE_AND_ALTERNATE_FLOW', 'NO_ASSUME_AND_QUERY', 'DEGRADE_TO_DETERMINISTIC', 'QUEUE_QUERY_OR_ALTERNATE_PROVIDER',
]);

const FAMILY_DEFAULT_MODE = Object.freeze({
  MESSAGING: 'QUEUE_AND_ALTERNATE',
  PORTAL: 'KEEP_INTERNAL_AND_REPROCESS',
  SIGNATURE: 'PRESERVE_AND_ALTERNATE_FLOW',
  IDENTITY: 'PRESERVE_AND_ALTERNATE_FLOW',
  BANK: 'NO_ASSUME_AND_QUERY',
  AI: 'DEGRADE_TO_DETERMINISTIC',
  FINANCING: 'QUEUE_QUERY_OR_ALTERNATE_PROVIDER',
});

/** Modos em que a contingência pode trocar a fila para a integração alternativa (o banco não assume; o portal preserva o dado; a IA responde na hora). */
const MODES_WITH_ALTERNATE = Object.freeze(['QUEUE_AND_ALTERNATE', 'PRESERVE_AND_ALTERNATE_FLOW', 'QUEUE_QUERY_OR_ALTERNATE_PROVIDER']);

/** Modos sem fila: a IA responde na hora pelo caminho determinístico. */
const MODES_WITHOUT_QUEUE = Object.freeze(['DEGRADE_TO_DETERMINISTIC']);

const ERROR_CODE = 'CONTINGENCY_ACTIVE';
const EVENTS = Object.freeze({
  ACTIVATED: 'integration.contingency.activated',
  DEACTIVATED: 'integration.contingency.deactivated',
  MANUAL_TASK: 'integration.contingency.manual_task',
  SWITCHED: 'integration.contingency.switched',
});
const REASONS = Object.freeze(['CIRCUIT_OPEN', 'AUTH_FAILED', 'PAUSED', 'NO_ACTIVE_CONNECTION', 'HEALTH_DOWN', 'QUEUE_AGE_EXCEEDED']);
const QUEUED_STATUSES = Object.freeze(['PENDING', 'RETRY_WAIT']);
const RELATED_ENTITY_TYPE = 'integration.dispatches';
const FAMILY_MARKER_PREFIX = 'familia:';

module.exports = {
  MODES, FAMILY_DEFAULT_MODE, MODES_WITH_ALTERNATE, MODES_WITHOUT_QUEUE, ERROR_CODE, EVENTS, REASONS, QUEUED_STATUSES, RELATED_ENTITY_TYPE, FAMILY_MARKER_PREFIX,
};
