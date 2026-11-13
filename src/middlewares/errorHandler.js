'use strict';

const AppError = require('../utils/AppError');
const { failure } = require('../utils/httpResponse');
const logger = require('../utils/logger');
const { redactText, redactDeep } = require('../shared/redaction');
const { debugBody } = require('../shared/destructive-actions/debug.policy');
const { mapBodyReaderError, mapPathDecodeError, mapUnstorableTextDbError } = require('./requestRead.errors');
const { limitarDetalhes, erroParaLog, respostaDeUltimoRecurso } = require('./errorHandler.safe');
const { mapClientDataDbError } = require('./dbClientErrors');

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
    // Rodada 8 (DI-M9R-25): o 409 da unicidade não ficava em registro nenhum; sai como aviso, com a restrição (sem o valor), para a equipe ver.
    logger.warn({ ...context, code: 'UNIQUE_CONSTRAINT_VIOLATION', statusCode: 409, sqlState: err.parent && err.parent.code, constraint: err.parent && err.parent.constraint }, '[ClientData] unicidade recusada pelo banco');
    // FIN-TS-001: a unicidade de idempotência do Financeiro vira o código de negócio (quem perde a corrida recebe o mesmo 409 da checagem).
    const financeMapped = require('../modules/finance/presentation/http/finance-unique-violations').mapFinanceUniqueViolation(err);
    if (financeMapped) return failure(res, financeMapped);
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

  // FIX (auditoria E2E de browser, 01/10/2026) e BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 2): o id de rota com formato inválido ("invalid
  // input syntax for type uuid") e o valor acima da precisão da coluna ("numeric field overflow") viravam 400 aqui, sem condição. Rodada 8
  // (DI-M9R-25): os dois são da classe 22 e passam pela mesma regra das demais (dbClientErrors.js): 400 INVALID_ID_FORMAT / VALUE_TOO_LARGE só
  // quando o valor recusado está no pedido; o mesmo erro com valor do servidor é 500 e aparece no registro como ERRO.

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
  const textoMapped = mapUnstorableTextDbError(err, req);
  if (textoMapped) {
    logger.warn({ ...context, code: textoMapped.code, statusCode: textoMapped.statusCode, sqlState: err.parent && err.parent.code }, '[RequestRead] texto que o banco não grava');
    return failure(res, textoMapped);
  }

  // Rodada 7 (DI-M9R-20), refeito na rodada 8 (DI-M9R-25): erro de DADO ou de INTEGRIDADE do banco (classes 22 e 23) é 4xx só com prova de que o
  // valor recusado veio do pedido (o campo do pedido com aquele valor, e com o nome da coluna quando ela é conhecida). Sem a prova, segue para o 500.
  const dadoMapped = mapClientDataDbError(err, req);
  if (dadoMapped) {
    logger.warn({ ...context, code: dadoMapped.code, statusCode: dadoMapped.statusCode, sqlState: err.parent && err.parent.code, fields: dadoMapped.details && dadoMapped.details.fields }, '[ClientData] valor do pedido recusado pelo banco');
    return failure(res, dadoMapped);
  }

  if (err && err.name === 'SequelizeValidationError') {
    return failure(res, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Dados inválidos.',
      details: err.errors ? limitarDetalhes(err.errors.map((e) => e.message)) : undefined,
    });
  }

  // Rodada 8 (DI-M9R-25): o guarda genérico de tipo da rodada 7 (clientTypeErrors.js, DI-M9R-21) foi retirado: a "prova" dele (o pedido tem um número,
  // um booleano, uma lista ou um campo com o nome da variável) transformava em 400 defeitos do servidor. Tipo errado de campo do pedido é recusado na
  // porta de cada rota (esquema), e o TypeError que chega aqui é do código: 500, registrado como ERRO com a pilha.
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
