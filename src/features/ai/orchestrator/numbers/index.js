'use strict';

const { auditNumbers, keepVerifiedSentences } = require('../numberAuditor');
const { enforceNumbers } = require('./enforceNumbers');
const { renderPlaceholders, formatItem } = require('./placeholders');
const { isCalculationTask, forcedRoutingPath, deterministicAnswer, produceNumericAnswer } = require('./calculationRoute');
const { sumExact, formatPtBr } = require('./decimalText');

/** Números financeiros vêm do read model, nunca do modelo (M9-D026). */
module.exports = {
  auditNumbers, keepVerifiedSentences, enforceNumbers, renderPlaceholders, formatItem, isCalculationTask, forcedRoutingPath,
  deterministicAnswer, produceNumericAnswer, sumExact, formatPtBr,
};
