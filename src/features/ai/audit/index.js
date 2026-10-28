'use strict';

const { safeLogger } = require('./safeLogger');
const sanitizer = require('./auditSanitizer');
const settings = require('./audit.settings');

/** Auditoria segura da NAY (M9-D028): sanitização do que é guardado e logger sem segredos. */
module.exports = { safeLogger, ...sanitizer, ...settings };
