'use strict';

/** Constantes do orçamento da NAY (M9-D014). Os valores seguem o livro; o que varia está em budgets.settings.js. */
const MODEL_CLASSES = Object.freeze(['SMALL', 'ADVANCED', 'EMBEDDING']);
const STATUSES = Object.freeze(['ACTIVE', 'PAUSED']);
const ACTIONS_AT_100 = Object.freeze(['BLOCK', 'DEGRADE']);
const CRITICALITY = Object.freeze({ CRITICAL: 'CRITICAL', NON_CRITICAL: 'NON_CRITICAL' });
/** Caminhos de roteamento da D012; EMBEDDING é tratado como modelo pequeno na política (e como classe EMBEDDING no escopo). */
const ROUTING_PATHS = Object.freeze(['RULE', 'CACHE', 'SMALL_MODEL', 'ADVANCED_MODEL', 'EMBEDDING']);
const PAID_PATHS = Object.freeze(['SMALL_MODEL', 'ADVANCED_MODEL', 'EMBEDDING']);
const CLASS_BY_PATH = Object.freeze({ SMALL_MODEL: 'SMALL', ADVANCED_MODEL: 'ADVANCED', EMBEDDING: 'EMBEDDING' });
const TIME_ZONE = 'America/Sao_Paulo';
const EVENT_THRESHOLD = 'ai.budget.threshold_reached';
const PERMISSIONS = Object.freeze({ edit: 'ai:budget', read: 'ai:audit' });

module.exports = {
  MODEL_CLASSES, STATUSES, ACTIONS_AT_100, CRITICALITY, ROUTING_PATHS, PAID_PATHS, CLASS_BY_PATH, TIME_ZONE, EVENT_THRESHOLD, PERMISSIONS,
};
