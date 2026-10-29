'use strict';

/** Constantes da recomendação da NAY (M9-D007). Os valores seguem o livro e a demanda; não há regra variável aqui. */
const STATUSES = Object.freeze(['PENDING', 'ACCEPTED', 'REJECTED', 'STALE', 'EXECUTED', 'EXECUTION_FAILED', 'EXPIRED']);
const RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const DECISIONS = Object.freeze(['ACCEPTED', 'REJECTED']);
const OUTCOMES = Object.freeze(['EXECUTED', 'EXECUTION_FAILED', 'NOT_APPLICABLE']);
/** Resultado que o executor (D019) grava depois do aceite. */
const EXECUTION_OUTCOMES = Object.freeze(['EXECUTED', 'EXECUTION_FAILED']);
/** Risco que exige decisor diferente de quem solicitou o run (parâmetro ia.aprovacao.aprovador_distinto). */
const DISTINCT_APPROVER_RISKS = Object.freeze(['HIGH', 'CRITICAL']);
const EVENTS = Object.freeze({ created: 'ai.recommendation.created', accepted: 'ai.recommendation.accepted', rejected: 'ai.recommendation.rejected' });

module.exports = { STATUSES, RISK_LEVELS, DECISIONS, OUTCOMES, EXECUTION_OUTCOMES, DISTINCT_APPROVER_RISKS, EVENTS };
