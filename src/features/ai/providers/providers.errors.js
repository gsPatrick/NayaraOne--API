'use strict';

const AppError = require('../../../utils/AppError');

/**
 * Erros dos providers de modelo (M9-D010 e M9-D011). `AiProviderError` é o erro NORMALIZADO que todo adapter devolve, seja qual
 * for o fornecedor: `kind` diz o que houve e `retryable` diz se repetir adianta. AUTH e VALIDATION nunca são reenviados (INT-006).
 * A mensagem é sempre nossa, em português: o texto do fornecedor nunca entra (poderia trazer a credencial ou dado da empresa).
 */
const KINDS = Object.freeze(['TIMEOUT', 'RATE_LIMIT', 'AUTH', 'VALIDATION', 'UNAVAILABLE', 'SAFETY_BLOCKED', 'UNKNOWN']);

const BY_KIND = Object.freeze({
  TIMEOUT: { status: 504, code: 'AI_PROVIDER_TIMEOUT', message: 'O provedor de IA demorou demais para responder.', retryable: true },
  RATE_LIMIT: { status: 429, code: 'AI_PROVIDER_RATE_LIMIT', message: 'O provedor de IA limitou as chamadas. Tente novamente em instantes.', retryable: true },
  AUTH: { status: 502, code: 'AI_PROVIDER_AUTH', message: 'O provedor recusou a credencial configurada.', retryable: false },
  VALIDATION: { status: 422, code: 'AI_PROVIDER_VALIDATION', message: 'O provedor recusou o pedido por formato inválido.', retryable: false },
  UNAVAILABLE: { status: 503, code: 'AI_PROVIDER_UNAVAILABLE', message: 'O provedor de IA está indisponível no momento.', retryable: true },
  SAFETY_BLOCKED: { status: 422, code: 'AI_PROVIDER_SAFETY_BLOCKED', message: 'O provedor bloqueou o conteúdo por segurança.', retryable: false },
  UNKNOWN: { status: 502, code: 'AI_PROVIDER_ERROR', message: 'O provedor de IA devolveu um erro inesperado.', retryable: false },
});

class AiProviderError extends AppError {
  /** `extra`: { providerCode, upstreamStatus, upstreamCode, retryAfterMs } — nunca texto livre do fornecedor. */
  constructor(kind, extra = {}) {
    const def = BY_KIND[kind] || BY_KIND.UNKNOWN;
    const details = {};
    ['providerCode', 'upstreamStatus', 'upstreamCode', 'retryAfterMs'].forEach((k) => { if (extra[k] !== undefined && extra[k] !== null) details[k] = extra[k]; });
    super(extra.message || def.message, extra.status || def.status, extra.code || def.code, Object.keys(details).length ? details : undefined);
    this.name = 'AiProviderError';
    this.kind = BY_KIND[kind] ? kind : 'UNKNOWN';
    this.retryable = BY_KIND[kind] ? def.retryable : false;
  }
}

const capabilityUnsupported = (operation) => new AppError(
  'O provedor não suporta esta capacidade.', 501, 'AI_CAPABILITY_UNSUPPORTED', operation ? { operation } : undefined
);
const providerNotConfigured = () => new AppError('Informe a credencial do provedor antes de ativá-lo.', 400, 'AI_PROVIDER_NOT_CONFIGURED');
const sandboxNotAllowedInProduction = () => new AppError('O provedor de testes não pode ser usado em produção.', 409, 'AI_SANDBOX_NOT_ALLOWED_IN_PRODUCTION');
const providerNotFound = () => new AppError('Provedor não encontrado.', 404, 'AI_PROVIDER_NOT_FOUND');
const providerNotEnabled = () => new AppError('O provedor não está habilitado para esta empresa.', 409, 'AI_PROVIDER_NOT_ENABLED');
const adminRequired = () => new AppError('Só quem administra a NAY altera o que o provedor aceita receber.', 403, 'AI_ADMIN_REQUIRED');

module.exports = {
  AiProviderError, KINDS, BY_KIND, capabilityUnsupported, providerNotConfigured, sandboxNotAllowedInProduction, providerNotFound, providerNotEnabled, adminRequired,
};
