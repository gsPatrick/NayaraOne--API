'use strict';

const { AiEvaluationService } = require('./AiEvaluationService');
const { requestEvaluation } = require('./evaluations.request');
const { getEvaluation, listEvaluations } = require('./evaluations.read');
const { homologateEvaluation } = require('./evaluations.homologate');
const { processQueued } = require('./evaluationRunner');
const { recordFeedback } = require('./feedback/feedback.service');
const { listCandidates, decideCandidate } = require('./feedback/goldenCandidates.service');
const { registerEvalProvider } = require('./evalProviders');
const { registerCaseSource } = require('./cases/caseSources');
const { isHighImpact } = require('./highImpact');
const settings = require('./evaluations.settings');
const constants = require('./evaluations.constants');

module.exports = {
  AiEvaluationService, requestEvaluation, getEvaluation, listEvaluations, homologateEvaluation, processQueued, recordFeedback, listCandidates, decideCandidate,
  registerEvalProvider, registerCaseSource, isHighImpact, ...settings, constants,
};
