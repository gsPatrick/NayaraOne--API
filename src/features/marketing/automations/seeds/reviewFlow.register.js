'use strict';

const runner = require('../runner');
const reviews = require('../reviews');
const { registerSeed } = require('./install');
const { reviewDefinition, actionableFilter, REVIEW_CODE, REVIEW_FILTER } = require('./reviewFlow');

/** M9-D424: registra o serviço de pedido de avaliação na porta do runner, o filtro das notas que agem e a automação pronta da satisfação. */
function registerReviewSeeds() {
  runner.reviewPort.registerReviewRequester(reviews.requestReview);
  runner.registerTriggerFilter(REVIEW_FILTER, actionableFilter);
  registerSeed(REVIEW_CODE, reviewDefinition);
}

module.exports = { registerReviewSeeds };
