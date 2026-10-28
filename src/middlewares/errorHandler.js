'use strict';

const AppError = require('../utils/AppError');
const { failure } = require('../utils/httpResponse');
const logger = require('../utils/logger');

/**
 * Middleware de erro global do Express — único ponto que traduz qualquer
 * exceção (operacional ou não) em resposta HTTP padronizada.
 * Deve ser o último middleware montado em app.js.
 *
 * FIX TEC-13 (homologação 10/09/2026): antes só logava em dev, e como texto livre. Agora todo
 * erro (esperado ou não) vira um log estruturado com correlationId + rota, sempre — em
 * produção também, porque é exatamente lá que se precisa investigar um incidente depois.
 */
const MISSING_CONFIG_RESPONSES = {
  FILES_CRYPTO_CONFIG_MISSING: { code: 'FILES_STORAGE_NOT_CONFIGURED', message: 'O armazenamento de arquivos não está configurado neste ambiente. Avise o administrador.' },
  MFA_CRYPTO_CONFIG_MISSING: { code: 'MFA_NOT_CONFIGURED', message: 'A verificação em duas etapas não está configurada neste ambiente. Avise o administrador.' },
  JWT_CONFIG_MISSING: { code: 'SERVER_NOT_CONFIGURED', message: 'O servidor não está configurado corretamente neste ambiente. Avise o administrador.' },
  PII_HASH_CONFIG_MISSING: { code: 'SERVER_NOT_CONFIGURED', message: 'O servidor não está configurado corretamente neste ambiente. Avise o administrador.' },
};

// M9-D401 acrescenta MK002 (resultado de publicação append-only) e MK003 (versão de automação imutável).
// M9-D400: erros previsíveis do schema "marketing" (trigger de versão imutável, CHECKs da campanha e contexto de
// empresa ausente) viram resposta amigável em português em vez de erro cru do banco.
const MKT_CAMPAIGN_CHECK_MESSAGES = {
  mkt_campaigns_objective_chk: 'Informe o objetivo da campanha (mínimo 10 caracteres).',
  mkt_campaigns_budget_justification_chk: 'Informe a justificativa do orçamento zerado da campanha.',
  mkt_campaigns_period_chk: 'O fim da campanha deve ser depois do início.',
  mkt_campaigns_objective_metric_chk: 'Escolha uma métrica-alvo válida para a campanha.',
  mkt_campaigns_target_value_chk: 'A meta da campanha deve ser maior que zero.',
};

function mapMarketingDatabaseError(err) {
  const pg = err && err.parent;
  if (!pg || typeof pg !== 'object') return null;
  if (pg.code === 'MK001') {
    return { statusCode: 409, code: 'MKT_CONTENT_VERSION_IMMUTABLE', message: 'A versão do conteúdo é imutável; crie uma nova versão.' };
  }
  if (pg.code === 'MK002') {
    return { statusCode: 409, code: 'MKT_RESULT_APPEND_ONLY', message: 'O resultado de publicação não pode ser alterado.' };
  }
  if (pg.code === 'MK003') {
    return { statusCode: 409, code: 'MKT_AUTOMATION_VERSION_IMMUTABLE', message: 'A versão publicada é imutável; crie uma nova versão.' };
  }
  if (pg.code === '23502' && pg.schema === 'marketing' && (pg.column === 'group_id' || pg.column === 'company_id')) {
    return { statusCode: 400, code: 'MKT_TENANT_REQUIRED', message: 'O contexto de empresa é obrigatório.' };
  }
  if (pg.code === '23514' && typeof pg.constraint === 'string' && pg.constraint.startsWith('mkt_campaigns_')) {
    return { statusCode: 400, code: 'MKT_CAMPAIGN_VALIDATION', message: MKT_CAMPAIGN_CHECK_MESSAGES[pg.constraint] || 'Os dados da campanha são inválidos.' };
  }
  return null;
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isProduction = process.env.NODE_ENV === 'production';
  const context = { correlationId: req.correlationId, method: req.method, path: req.originalUrl };

  // F-01 (conferência ao vivo 20/10/2026): variável de ambiente ausente é problema do servidor, não
  // do usuário. A tela não pode mostrar o nome da variável: o detalhe vai só para o log.
  if (err instanceof AppError && MISSING_CONFIG_RESPONSES[err.code]) {
    const mapped = MISSING_CONFIG_RESPONSES[err.code];
    logger.error({ ...context, code: err.code, statusCode: 503 }, `[AppError] ${err.code}: ${err.message}`);
    return failure(res, { statusCode: 503, code: mapped.code, message: mapped.message });
  }

  if (err instanceof AppError) {
    logger.warn({ ...context, code: err.code, statusCode: err.statusCode }, `[AppError] ${err.code}: ${err.message}`);
    return failure(res, {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
    });
  }

  // Erros de validação/otimista do Sequelize viram 409/400 amigáveis.
  if (err && err.name === 'SequelizeOptimisticLockError') {
    return failure(res, {
      statusCode: 409,
      code: 'OPTIMISTIC_LOCK_CONFLICT',
      message: 'O registro foi modificado por outra operação concorrente. Recarregue e tente novamente.',
    });
  }

  if (err && err.name === 'SequelizeUniqueConstraintError') {
    return failure(res, {
      statusCode: 409,
      code: 'UNIQUE_CONSTRAINT_VIOLATION',
      message: 'Violação de restrição de unicidade.',
      details: err.errors ? err.errors.map((e) => e.message) : undefined,
    });
  }

  const marketingMapped = mapMarketingDatabaseError(err);
  if (marketingMapped) return failure(res, marketingMapped);

  // FIX (auditoria E2E de browser, 01/10/2026): um id de rota com formato inválido (ex.:
  // /construction/projects/id-que-nao-existe-123, resultado comum de favoritos velhos ou link
  // direto digitado errado) batia direto no Postgres como SequelizeDatabaseError ("invalid
  // input syntax for type uuid: ..."), caía no catch-all abaixo e virava 500 com a mensagem
  // crua do Postgres em INGLÊS exibida ao usuário — um 404/400 amigável é o esperado aqui, não
  // um erro interno (não é uma falha do servidor, é um identificador que o usuário passou).
  if (err && err.name === 'SequelizeDatabaseError' && /invalid input syntax for type uuid/i.test(err.message || '')) {
    return failure(res, {
      statusCode: 400,
      code: 'INVALID_ID_FORMAT',
      message: 'O identificador informado não é válido.',
    });
  }

  // BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 2): quantidade/valor acima da precisão da
  // coluna DECIMAL (ex.: "999999" num campo DECIMAL(9,6), que só comporta 3 dígitos inteiros)
  // batia no Postgres como "numeric field overflow" e vazava cru pro usuário — mesma classe de
  // vazamento de erro de infraestrutura já corrigida acima pra UUID inválido.
  if (err && err.name === 'SequelizeDatabaseError' && /numeric field overflow/i.test(err.message || '')) {
    return failure(res, {
      statusCode: 400,
      code: 'VALUE_TOO_LARGE',
      message: 'O valor informado é grande demais para este campo.',
    });
  }

  // BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 4, 2026-10-06): upload de arquivo
  // acima do limite do body parser (`express.json({ limit: '28mb' })` em app.js) é interceptado
  // ANTES de chegar no check limpo de MAX_BYTES em files.service.js, batendo como
  // PayloadTooLargeError cru e vazando "request entity too large" com 500 INTERNAL_ERROR em vez
  // de um 400 amigável — mesma classe de vazamento de erro de infraestrutura já corrigida acima.
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return failure(res, {
      statusCode: 400,
      code: 'FILE_UPLOAD_TOO_LARGE',
      message: 'O arquivo enviado é grande demais.',
    });
  }

  // BUG REAL CORRIGIDO (auditoria adversarial pós-DoD do Marco 8, Frente 8 — Validação/Casos
  // extremos): um corpo JSON malformado (ex.: JSON.stringify quebrado, corpo truncado, cliente
  // bugado) é rejeitado pelo `express.json()` ANTES de chegar em qualquer controller, como
  // SyntaxError com `err.type === 'entity.parse.failed'` — caía no catch-all abaixo e virava 500
  // INTERNAL_ERROR em vez de um 400 amigável. Mesma classe de vazamento de erro de
  // infraestrutura já corrigida acima para UUID inválido / overflow numérico / payload grande.
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in (err || {})))) {
    return failure(res, {
      statusCode: 400,
      code: 'INVALID_JSON_BODY',
      message: 'O corpo da requisição não é um JSON válido.',
    });
  }

  if (err && err.name === 'SequelizeValidationError') {
    return failure(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Dados inválidos.',
      details: err.errors ? err.errors.map((e) => e.message) : undefined,
    });
  }

  logger.error({ ...context, err: { message: err?.message, name: err?.name, stack: err?.stack } }, '[UnhandledError]');

  return failure(res, {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: isProduction ? 'Erro interno do servidor.' : err && err.message ? err.message : 'Erro interno do servidor.',
  });
}

module.exports = errorHandler;
