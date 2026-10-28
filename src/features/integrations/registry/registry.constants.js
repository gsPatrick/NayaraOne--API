'use strict';

/** Constantes do registro de integração (Marco 9, M9-D200). */

const DOMAINS = ['MESSAGING', 'EMAIL', 'SITE', 'PORTAL', 'SIGNATURE', 'BANK', 'INSURANCE', 'FINANCING', 'FISCAL', 'SOCIAL', 'STORAGE', 'IDENTITY', 'AI', 'ANALYTICS'];
const CRITICALITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const PROVIDER_STATUSES = ['ACTIVE', 'DEPRECATED', 'DISABLED'];
const ENVIRONMENTS = ['SANDBOX', 'HOMOLOG', 'PRODUCTION'];
const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'AUTH_FAILED', 'DISABLED'];

// Transições do livro (D200 3.2 f). `DISABLED` é final.
const TRANSITIONS = {
  DRAFT: ['ACTIVE', 'DISABLED'],
  ACTIVE: ['PAUSED', 'AUTH_FAILED', 'DISABLED'],
  PAUSED: ['ACTIVE', 'DISABLED'],
  AUTH_FAILED: ['ACTIVE', 'DISABLED'],
  DISABLED: [],
};

const ANTES_CRIACAO = 'Não existia (registro criado nesta ação)';
const CODE_RE = /^[a-z0-9_-]{1,48}$/;
const CAMPOS_CONEXAO_EDITAVEIS = ['label', 'configJson', 'policyJson', 'apiVersion', 'secretRef', 'webhookChannel'];

module.exports = { DOMAINS, CRITICALITIES, PROVIDER_STATUSES, ENVIRONMENTS, STATUSES, TRANSITIONS, ANTES_CRIACAO, CODE_RE, CAMPOS_CONEXAO_EDITAVEIS };
