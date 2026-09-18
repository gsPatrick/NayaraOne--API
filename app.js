'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const routes = require('./src/routes');
const errorHandler = require('./src/middlewares/errorHandler');
const logger = require('./src/utils/logger');
const { correlationIdMiddleware } = require('./src/middlewares/correlationId.middleware');
const { requestLoggerMiddleware, metricsRecorderMiddleware } = require('./src/middlewares/requestLogger.middleware');
const { register: metricsRegister } = require('./src/utils/metrics');
const { startRadarMatchingJob } = require('./src/engines/jobs/radarMatchingJob');
const { startOutboxDispatcherJob } = require('./src/engines/jobs/outboxDispatcherJob');
const { startLegalDeadlineAlertJob } = require('./src/engines/jobs/legalDeadlineAlertJob');
const { startFeedbackCaseAlertJob } = require('./src/engines/jobs/feedbackCaseAlertJob');

const app = express();

// TEC-08: correlation ID por requisição — precisa vir antes de qualquer outro middleware pra
// cobrir toda a cadeia de chamadas (auditoria, eventos) desde o primeiro byte processado.
app.use(correlationIdMiddleware);

// TEC-13: log estruturado + métrica de latência por requisição — /health e /api/metrics ficam
// de fora do log (ruído de healthcheck/scraping, não interessa pra investigar incidente).
app.use(requestLoggerMiddleware);
app.use(metricsRecorderMiddleware);

// TEC-13: endpoint Prometheus — formato padrão, qualquer coletor (Prometheus, Grafana Cloud,
// Better Stack etc.) sabe ler direto. Funciona sozinho via `curl` mesmo sem nenhum coletor
// configurado. Fora do prefixo /api/v1 (mesmo padrão de /health), fora de qualquer auth (é
// leitura operacional agregada, não dado de negócio de tenant nenhum — mesmo padrão do /health).
app.get('/api/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegister.contentType);
  res.end(await metricsRegister.metrics());
});

// CORS — permite chamadas do(s) frontend(s) autorizados via CORS_ORIGIN (lista separada por
// vírgula). Sem variável definida, libera geral (uso aceitável em homologação; em produção
// definir CORS_ORIGIN explicitamente com o(s) domínio(s) real(is) do frontend).
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  })
);

// Middlewares globais.
// `verify` guarda o corpo bruto (Buffer) em `req.rawBody` — necessário para validar a
// assinatura HMAC de webhooks de provedores externos (ex.: assinatura eletrônica) sobre os
// BYTES exatos recebidos, antes de qualquer parsing/normalização do JSON. Não afeta nenhuma
// outra rota: o corpo já parseado (`req.body`) continua disponível normalmente.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

const apiPrefix = process.env.APP_API_PREFIX || '/api';

app.use(apiPrefix, routes);

// Rota raiz simples — não substitui /health, apenas facilita smoke test manual.
app.get('/', (req, res) => {
  res.status(200).json({ success: true, data: { name: 'Nayara One API', apiPrefix } });
});

// Error handler global — deve ser o último middleware montado.
app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  logger.info({ port, apiPrefix }, `Nayara One API ouvindo na porta ${port} (prefixo ${apiPrefix})`);
});

// Job periódico de matching do Radar — não roda em ambiente de teste (evita efeitos
// colaterais/timers pendurados em test runners que importam este arquivo).
if (process.env.NODE_ENV !== 'test' && process.env.RADAR_MATCHING_JOB_DISABLED !== 'true') {
  startRadarMatchingJob();
}

// Despachante do Outbox (TEC-06/TEC-07) — existia desde antes mas nunca era chamado por nada;
// todo evento gravado ficava PENDING para sempre. Roda a cada 30s dentro do próprio processo.
if (process.env.NODE_ENV !== 'test' && process.env.OUTBOX_DISPATCHER_JOB_DISABLED !== 'true') {
  startOutboxDispatcherJob();
}

// Alertas de prazos jurídicos (reportado pela cliente 14/09/2026 — "prazos e alertas
// efetivamente utilizáveis"). Roda a cada 30 min dentro do próprio processo.
if (process.env.NODE_ENV !== 'test' && process.env.LEGAL_DEADLINE_ALERT_JOB_DISABLED !== 'true') {
  startLegalDeadlineAlertJob();
}

// Escalonamento de reclamações/elogios/conflitos com SLA vencido (M3-20, 18/09/2026).
if (process.env.NODE_ENV !== 'test' && process.env.FEEDBACK_CASE_ALERT_JOB_DISABLED !== 'true') {
  startFeedbackCaseAlertJob();
}

module.exports = app;
