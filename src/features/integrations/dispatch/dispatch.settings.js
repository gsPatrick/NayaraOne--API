'use strict';

const { RECONCILE_SETTINGS_SCHEMA } = require('./reconcile/reconcile.settings');
const { SOCIAL_SETTINGS_SCHEMA } = require('../social/social.settings');
const { EMAIL_SETTINGS_SCHEMA } = require('../email/email.settings');

/** Parâmetros dos envios (M9-D205): só o dicionário de SETTINGS_SCHEMA; a leitura está em dispatch.params.js. */
const DISPATCH_SETTINGS_SCHEMA = Object.freeze({
  // INT-P011: segundos em SENDING sem resposta até o recuperador mandar o envio para UNKNOWN.
  'integration.dispatch.sending_stale_s': { type: 'integer', min: 10, max: 86400 },
  // INT-P012: dias que um envio CONFIRMED ou CANCELLED fica guardado.
  'integration.dispatch.retention_days': { type: 'integer', min: 1, max: 3650 },
  // INT-P013: dias até o conteúdo enviado virar só o hash.
  'integration.dispatch.payload_retention_days': { type: 'integer', min: 1, max: 3650 },
  // INT-P004: tentativas máximas de um envio novo (o retry humano soma 3).
  'integration.retry.max_attempts': { type: 'integer', min: 1, max: 20 },
  // M9-D216 3.2: atraso da nova tentativa de erro transitório (base * fator^(n-1), no máximo o teto, com jitter para mais ou para menos),
  // espera máxima atendida em 429 e quantos adiamentos seguidos por limite do fornecedor valem antes de contar como falha.
  'integration.retry.base_delay_ms': { type: 'integer', min: 100, max: 3600000 },
  'integration.retry.factor': { type: 'integer', min: 1, max: 10 },
  'integration.retry.cap_delay_ms': { type: 'integer', min: 1000, max: 86400000 },
  'integration.retry.jitter_pct': { type: 'integer', min: 0, max: 50 },
  'integration.retry.rate_limit_max_wait_s': { type: 'integer', min: 1, max: 86400 },
  'integration.retry.rate_limit_max_deferrals': { type: 'integer', min: 1, max: 10000 },
  // M9-D218 3.2 e 3.4: abaixo desta porcentagem da cota do fornecedor só operação essencial ou perigosa sai (INT-P023); sem data de renovação
  // da cota, a operação que espera volta a ser conferida depois deste tempo.
  'integration.rate_limit.reserve_pct': { type: 'integer', min: 0, max: 100 },
  'integration.rate_limit.fallback_wait_s': { type: 'integer', min: 1, max: 86400 },
  // M9-D214 3.2: de quantos em quantos segundos o worker de envios roda, quantos envios pega por rodada e quanto espera antes de
  // reconferir uma conexão parada (PAUSED, DISABLED, AUTH_FAILED ou sem adaptador) sem gastar tentativa.
  'integration.dispatch.worker_interval_s': { type: 'integer', min: 1, max: 3600 },
  'integration.dispatch.worker_batch_size': { type: 'integer', min: 1, max: 500 },
  'integration.dispatch.blocked_recheck_s': { type: 'integer', min: 5, max: 86400 },
  // M9-D243 3.1 (INT-P090): segundos que uma métrica ou evento de analytics espera para sair; passado o prazo é descartado, sem afetar o negócio.
  'integration.analytics.drop_after_s': { type: 'integer', min: 1, max: 86400 },
  // M9-D215: reconciliação do envio incerto (consultas, esperas, job) e recuperador de envios presos em SENDING.
  ...RECONCILE_SETTINGS_SCHEMA,
  // M9-D239: redes sociais (janela de dias para achar o post duplicado e política de publicação automática).
  ...SOCIAL_SETTINGS_SCHEMA,
  // M9-D234: e-mail de saída (limite e tipos de anexo, teto de classificação, destinatários).
  ...EMAIL_SETTINGS_SCHEMA,
});

module.exports = { DISPATCH_SETTINGS_SCHEMA };
