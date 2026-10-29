'use strict';

const patterns = require('./patterns');
const text = require('./text');
const { redactDeep } = require('./deep');
const { isSensitiveKey, SENSITIVE_KEY_NAMES } = require('./keys');
const detect = require('./detect');
const { describeForLog } = require('./webhookLog');
const { createRedactingStream } = require('./stream');
const { CONSERVATIVE_SECRET_PATTERNS } = require('./conservative');
const aiProfile = require('./aiProfile');
const freeText = require('./freeText');

module.exports = {
  ...text, ...detect, ...aiProfile, ...freeText, redactDeep, isSensitiveKey, SENSITIVE_KEY_NAMES, describeForLog, createRedactingStream, CONSERVATIVE_SECRET_PATTERNS,
  rx: patterns.rx, SOURCES: patterns.SOURCES, luhnValid: patterns.luhnValid, cpfValid: patterns.cpfValid, cnpjValid: patterns.cnpjValid,
};
