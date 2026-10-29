'use strict';

/** Auditoria de dependências e SDKs (Marco 9, M9-D248). Fachada da API pública. */
const { runNpmAudit } = require('./depaudit.runner');
const { parseAuditReport, evaluateAudit, advisoryRefId } = require('./depaudit.evaluate');
const { loadExceptions, exceptionState } = require('./depaudit.exceptions');
const { checkPinnedSdks } = require('./depaudit.pin');
const { auditCompany, readPackageJson } = require('./depaudit.service');
const { readDepAuditParams } = require('./depaudit.params');
const constants = require('./depaudit.constants');

module.exports = {
  runNpmAudit, parseAuditReport, evaluateAudit, advisoryRefId, loadExceptions, exceptionState, checkPinnedSdks, auditCompany, readPackageJson, readDepAuditParams, constants,
};
