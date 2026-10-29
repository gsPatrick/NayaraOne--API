'use strict';

const { createRecommendation } = require('./recommendation.create');
const { acceptRecommendation, rejectRecommendation } = require('./recommendation.decide');
const { recordOutcome, markStale } = require('./recommendation.outcome');
const { listRecommendations, pageRecommendations, getRecommendation } = require('./recommendation.read');
const { registerSnapshotChecker, staleError } = require('./recommendation.snapshot');

/** Fachada do serviço de recomendação da NAY (M9-D007): recomendação, decisão humana e resultado. */
module.exports = {
  createRecommendation, acceptRecommendation, rejectRecommendation, recordOutcome, markStale, listRecommendations, pageRecommendations, getRecommendation,
  registerSnapshotChecker, staleError,
};
