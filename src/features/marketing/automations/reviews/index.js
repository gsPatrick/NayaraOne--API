'use strict';

const { requestReview } = require('./review.service');
const { recordPlatformReturn } = require('./review.complete');
const { onDeliveryStatus } = require('./review.delivery');
const { registerTrackingLinkPort } = require('./review.ports');
const { installReviewGuards } = require('./review.guard');
const { classify } = require('./review.classify');
const { readReviewParams, REVIEW_SETTINGS_SCHEMA } = require('./review.settings');
const { reviewBlockedOpenCase } = require('./review.errors');

installReviewGuards();

/** Pedido de avaliação (M9-D424): satisfação positiva pede a avaliação; negativa abre a ocorrência antes e não pede nada. */
module.exports = { requestReview, recordPlatformReturn, onDeliveryStatus, registerTrackingLinkPort, classify, readReviewParams, REVIEW_SETTINGS_SCHEMA, reviewBlockedOpenCase };
