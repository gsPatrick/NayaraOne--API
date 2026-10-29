'use strict';

const path = require('node:path');

/** Auditoria de dependências (M9-D248). Códigos, severidades e caminhos fixos do livro; os prazos são parâmetros. */
const BLOCKING_SEVERITIES = Object.freeze(['high', 'critical']);
const ERROR_CODE = 'SDK_VULNERABILITY';
const FAILED_CODE = 'INTEGRATION_DEPENDENCY_AUDIT_FAILED';
const FAILED_MESSAGE = 'Vulnerabilidade grave em dependência: atualize ou registre exceção com validade.';
const API_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const EXCEPTIONS_FILE = path.join(API_ROOT, 'security', 'audit-exceptions.json');
const REQUIRED_FIELDS = Object.freeze(['id', 'package', 'reason', 'mitigation', 'owner', 'grantedAt', 'expiresAt']);
/** Gravidade do npm -> severidade de integration_errors. */
const SEVERITY_MAP = Object.freeze({ critical: 'CRITICAL', high: 'HIGH' });
const DAY_MS = 24 * 3600 * 1000;

module.exports = { BLOCKING_SEVERITIES, ERROR_CODE, FAILED_CODE, FAILED_MESSAGE, API_ROOT, EXCEPTIONS_FILE, REQUIRED_FIELDS, SEVERITY_MAP, DAY_MS };
