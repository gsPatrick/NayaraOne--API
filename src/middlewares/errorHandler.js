'use strict';

const AppError = require('../utils/AppError');
const { failure } = require('../utils/httpResponse');
const logger = require('../utils/logger');
const { redactText, redactDeep } = require('../shared/redaction');
const { debugBody } = require('../shared/destructive-actions/debug.policy');
const { mapBodyReaderError, mapPathDecodeError, mapUnstorableTextDbError } = require('./requestRead.errors');
const { limitarDetalhes, erroParaLog, respostaDeUltimoRecurso } = require('./errorHandler.safe');
const { mapClientDataDbError } = require('./dbClientErrors');
const { mapClientTypeError, mapInvalidValueError, mapOperatorTypeError, mapFindByPkError } = require('./clientTypeErrors');

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
  if (pg.code === 'MK004') {
    return { statusCode: 409, code: 'MKT_TEMPLATE_IMMUTABLE', message: 'Template publicado não pode ser editado; crie uma nova versão.' };
  }
  if (pg.code === '23502' && pg.schema === 'marketing' && (pg.column === 'group_id' || pg.column === 'company_id')) {
    return { statusCode: 400, code: 'MKT_TENANT_REQUIRED', message: 'O contexto de empresa é obrigatório.' };
  }
  if (pg.code === '23514' && typeof pg.constraint === 'string' && pg.constraint.startsWith('mkt_campaigns_')) {
    return { statusCode: 400, code: 'MKT_CAMPAIGN_VALIDATION', message: MKT_CAMPAIGN_CHECK_MESSAGES[pg.constraint] || 'Os dados da campanha são inválidos.' };
  }
  return null;
}

/**
 * Isolamento entre empresas (10/11/2026): gravação recusada pelo WITH CHECK de uma política RLS (SQLSTATE 42501, "new row
 * violates row-level security policy") é registro fora da empresa em uso, não falha do servidor. Antes caía no 500
 * (POST /people/:id/consents de outra empresa do mesmo grupo). Só a mensagem de RLS é mapeada: 42501 de GRANT ausente
 * ("permission denied for table") continua 500, porque aí é configuração do servidor.
 */
function mapRlsViolation(err) {
  const pg = err && err.parent;
  if (!pg || pg.code !== '42501' || !/row-level security/i.test(String(pg.message || err.message || ''))) return null;
  return { statusCode: 403, code: 'TENANT_SCOPE_DENIED', message: 'Este registro não pertence à empresa em uso.' };
}

const isIntegrationRoute = (req) => /\/(integrations|webhooks)(\/|\?|$)/i.test(String(req.originalUrl || ''));

/** M9-D843 / K5: todo corpo de erro leva `error.traceId` (o correlationId da requisição, o mesmo de X-Correlation-Id); nunca na raiz. */
function attachTraceId(req, res) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && body.success === false && body.error && typeof body.error === 'object' && !body.error.traceId) {
      const { traceId: _root, ...root } = body;
      return json({ ...root, error: { ...body.error, traceId: req.correlationId || res.getHeader('X-Correlation-Id') || null } });
    }
    return json(body);
  };
}

/** M9-D852 §3.2: `governanca.ui.exibir_debug` (padrão desligado, proibido em produção). Falha ao ler = desligado; nunca derruba a resposta de erro. */
async function debugEnabled(req) {
  if (process.env.NODE_ENV === 'production' || !req.auth || typeof req.withTenantTransaction !== 'function') return false;
  try {
    const { getSetting } = require('../features/settings/settings.service');
    return (await req.withTenantTransaction((transaction) => getSetting('governanca.ui.exibir_debug', { groupId: req.auth.groupId, companyId: req.auth.companyId }, transaction, false))) === true;
  } catch (_err) {
    return false;
  }
}

/** A tradução do erro em resposta. Só é chamada pelo `errorHandler` abaixo, que a protege. */
async function tratarErro(err, req, res) {
  attachTraceId(req, res);
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
      // M9-D246: rotas de integração e webhooks nunca devolvem segredo na mensagem nem nos detalhes do erro.
      message: isIntegrationRoute(req) ? redactText(err.message, { secretsOnly: true }) : err.message,
      // Rodada 7 (DI-M9R-19): `details` só sai dentro de limites (profundidade, quantidade, tamanho), montado sem recursão.
      details: isIntegrationRoute(req) ? redactDeep(limitarDetalhes(err.details), { secretsOnly: true }) : limitarDetalhes(err.details),
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
      details: err.errors ? limitarDetalhes(err.errors.map((e) => e.message)) : undefined,
    });
  }

  const marketingMapped = mapMarketingDatabaseError(err);
  if (marketingMapped) return failure(res, marketingMapped);

  const rlsMapped = mapRlsViolation(err);
  if (rlsMapped) {
    logger.warn({ ...context, code: rlsMapped.code, statusCode: rlsMapped.statusCode, table: err.parent.table || null }, '[RLS] gravação fora do escopo da empresa recusada');
    return failure(res, rlsMapped);
  }

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

  // BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 4, 2026-10-06; auditoria adversarial pós-DoD do Marco 8, Frente 8): o corpo acima do
  // limite do leitor (`express.json({ limit: '28mb' })` em app.js) e o JSON malformado eram rejeitados ANTES de qualquer controller e caíam no 500.
  // Rodada 6 da verificação do Marco 9 (DI-M9R-14): TODOS os erros do leitor do corpo (charset e compressão não aceitos, corpo comprimido quebrado,
  // corpo interrompido, tamanho que não confere, campos demais) e o escape `%` malformado no caminho viram 400, 413 ou 415 (requestRead.errors.js).
  const leitura = mapBodyReaderError(err) || mapPathDecodeError(err);
  if (leitura) {
    const nivel = leitura.logServerSide ? 'error' : 'warn';
    logger[nivel]({ ...context, code: leitura.code, statusCode: leitura.statusCode, type: err.type || null, cause: err.code || null }, `[RequestRead] ${leitura.code}`);
    return failure(res, { statusCode: leitura.statusCode, code: leitura.code, message: leitura.message });
  }
  if (err && err.status === 413) {
    return failure(res, { statusCode: 400, code: 'FILE_UPLOAD_TOO_LARGE', message: 'O arquivo enviado é grande demais.' });
  }

  // Rodada 6 (DI-M9R-15): caractere nulo ou metade solta de par sub-rogado que chegou ao banco por fora da porta (parâmetro do caminho, por exemplo).
  const textoMapped = mapUnstorableTextDbError(err);
  if (textoMapped) {
    logger.warn({ ...context, code: textoMapped.code, statusCode: textoMapped.statusCode, sqlState: err.parent && err.parent.code }, '[RequestRead] texto que o banco não grava');
    return failure(res, textoMapped);
  }

  // Rodada 7 (DI-M9R-20): os demais erros de DADO do banco (classe 22: texto maior que a coluna, data inválida, número fora da faixa ...) e o
  // identificador com tipo errado (número ou objeto onde a rota espera UUID) são do valor enviado: 400, com o campo quando se sabe, nunca o valor.
  const dadoMapped = mapClientDataDbError(err);
  if (dadoMapped) {
    const { logLevel, ...resposta } = dadoMapped;
    const sqlState = err.parent && err.parent.code;
    if (logLevel === 'error') logger.error({ ...context, code: resposta.code, statusCode: resposta.statusCode, sqlState, err: erroParaLog(err) }, '[ClientData] valor recusado pelo banco sem validação na porta da rota');
    else logger.warn({ ...context, code: resposta.code, statusCode: resposta.statusCode, sqlState }, '[ClientData] valor recusado pelo banco');
    return failure(res, resposta);
  }

  if (err && err.name === 'SequelizeValidationError') {
    return failure(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Dados inválidos.',
      details: err.errors ? limitarDetalhes(err.errors.map((e) => e.message)) : undefined,
    });
  }

  // Rodada 7 (DI-M9R-21): TypeError com prova no pedido (o campo citado pela expressão tem o tipo errado) é 400; o registro sai como ERRO.
  const tipoMapped = mapClientTypeError(err, req) || mapInvalidValueError(err, req) || mapOperatorTypeError(err, req) || mapFindByPkError(err, req);
  if (tipoMapped) {
    logger.error({ ...context, code: tipoMapped.code, statusCode: 400, fields: tipoMapped.details.fields, err: erroParaLog(err) }, '[ClientType] campo com tipo errado chegou ao código sem validação na porta da rota');
    return failure(res, tipoMapped);
  }

  logger.error({ ...context, err: erroParaLog(err) }, '[UnhandledError]');

  // M9-D852: a pessoa vê uma frase em português com o código de suporte (o mesmo correlationId dos logs e da auditoria); stack, SQL e caminhos
  // nunca vão no corpo. Fora de produção, e só com o parâmetro ligado, o campo separado `debug` leva a mensagem e a stack.
  const traceId = req.correlationId || res.getHeader('X-Correlation-Id') || null;
  const debug = debugBody(err, await debugEnabled(req));
  const body = { success: false, error: { code: 'INTERNAL_ERROR', message: `Algo deu errado. Informe o código ${traceId} ao suporte.`, traceId } };
  if (debug) body.error.debug = debug;
  return res.status(500).json(body);
}

/**
 * Middleware de erro do Express. Rodada 7 (DI-M9R-19): nunca lança e nunca deixa o pedido sem resposta. A tradução (`tratarErro`) é assíncrona; se
 * ela lançar ou a promessa for rejeitada (resposta impossível de serializar, por exemplo), sai a resposta mínima de último recurso. Se a resposta já
 * começou a sair, o erro segue para o tratamento padrão do Express, que encerra a conexão.
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    try { logger.error({ correlationId: req.correlationId, method: req.method, path: req.originalUrl, err: erroParaLog(err) }, '[ErrorHandler] erro depois do início da resposta'); } catch (_e) { /* */ }
    return next(err);
  }
  let pendente;
  try {
    pendente = tratarErro(err, req, res);
  } catch (falha) {
    return respostaDeUltimoRecurso({ falha, original: err, req, res, log: logger });
  }
  Promise.resolve(pendente).catch((falha) => respostaDeUltimoRecurso({ falha, original: err, req, res, log: logger }));
  return undefined;
}

module.exports = errorHandler;
module.exports.mapRlsViolation = mapRlsViolation;
