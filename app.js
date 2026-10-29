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
const { startCampaignLifecycleJob } = require('./src/engines/jobs/campaignLifecycleJob');
const { startMarketingContentTypesJob } = require('./src/engines/jobs/marketingContentTypesJob');
const { startCalendarBackfillJob } = require('./src/engines/jobs/calendarBackfillJob');
const { startCalendarOverdueJob } = require('./src/engines/jobs/calendarOverdueJob');
const { startCalendarConflictJob } = require('./src/engines/jobs/calendarConflictJob');
const { startOutboxDispatcherJob } = require('./src/engines/jobs/outboxDispatcherJob');
const { startLegalDeadlineAlertJob } = require('./src/engines/jobs/legalDeadlineAlertJob');
const { startLegalGuaranteeExpiryAlertJob } = require('./src/engines/jobs/legalGuaranteeExpiryAlertJob');
const { startFeedbackCaseAlertJob } = require('./src/engines/jobs/feedbackCaseAlertJob');
const { startCrmTaskOverdueJob } = require('./src/engines/jobs/crmTaskOverdueJob');
const { startWarrantyEscalationJob } = require('./src/engines/jobs/warrantyEscalationJob');
const { startProjectDelayDetectionJob } = require('./src/engines/jobs/projectDelayDetectionJob');
const { startMissingDailyReportJob } = require('./src/engines/jobs/missingDailyReportJob');
const { startToolLoanOverdueJob } = require('./src/engines/jobs/toolLoanOverdueJob');
const { startInsuranceRenewalAlertJob } = require('./src/engines/jobs/insuranceRenewalAlertJob');
const { startInsurancePolicyExpiryJob } = require('./src/engines/jobs/insurancePolicyExpiryJob');
const { startCaseDocumentExpiryJob } = require('./src/engines/jobs/caseDocumentExpiryJob');
const { startBillingScheduleAutoGenerateJob } = require('./src/engines/jobs/billingScheduleAutoGenerateJob');
const { startCollectionCadenceJob } = require('./src/engines/jobs/collectionCadenceJob');
const { startCorrespondentSubmissionWorkerJob } = require('./src/engines/jobs/correspondentSubmissionWorkerJob');
const { startCorrespondentAppraisalWorkerJob } = require('./src/engines/jobs/correspondentAppraisalWorkerJob');
const { startCorrespondentStatusPollJob } = require('./src/engines/jobs/correspondentStatusPollJob');
const { startBankPaymentReconciliationJob } = require('./src/engines/jobs/bankPaymentReconciliationJob');
const { startIntegrationHealthAggregateJob } = require('./src/engines/jobs/integrationHealthAggregateJob');
const { startIntegrationHealthCheckJob } = require('./src/engines/jobs/integrationHealthCheckJob');
const { startIntegrationAlertJob } = require('./src/engines/jobs/integrationAlertJob');
const { startAiRetentionJob } = require('./src/engines/jobs/aiRetentionJob');
const { startAiEvaluationJob } = require('./src/engines/jobs/aiEvaluationJob');
const { startAiBudgetPeriodJob } = require('./src/engines/jobs/aiBudgetPeriodJob');
const { startAiMemoryExpiryJob } = require('./src/engines/jobs/aiMemoryExpiryJob');
const { startAiRagJob } = require('./src/engines/jobs/aiRagJob');
const { startAnalyticsReadModelRefreshJob } = require('./src/engines/jobs/analyticsReadModelRefreshJob');
const { startAnalyticsMaterializedViewJob } = require('./src/engines/jobs/analyticsMaterializedViewJob');
const { startAnalyticsSnapshotJob } = require('./src/engines/jobs/analyticsSnapshotJob');
const { startDependencyAuditJob } = require('./src/engines/jobs/dependencyAuditJob');
const { startIntegrationRetentionJob } = require('./src/engines/jobs/integrationRetentionJob');
const { runMigrationsOnBoot } = require('./src/utils/runMigrationsOnBoot');
const { startIntegrationDispatchWorkerJob } = require('./src/engines/jobs/integrationDispatchWorkerJob');

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
const keepRawBody = (req, res, buf) => {
  req.rawBody = buf;
};
const jsonParser = express.json({
  // 28mb: cobre o limite de 20MB de src/features/files/files.service.js (upload de arquivo
  // via base64 infla ~33% o tamanho) + folga pro resto do payload JSON da requisição.
  limit: '28mb',
  verify: keepRawBody,
});
// Webhook público de financiamento: sem login, então o corpo aceito é pequeno (evento de status, não arquivo).
const webhookJsonParser = express.json({ limit: '256kb', verify: keepRawBody });
app.use((req, res, next) => (req.path.includes('/correspondent/webhooks/') ? webhookJsonParser(req, res, next) : jsonParser(req, res, next)));
app.use(express.urlencoded({ extended: true }));

const apiPrefix = process.env.APP_API_PREFIX || '/api';

app.use(apiPrefix, routes);

// Rota raiz simples — não substitui /health, apenas facilita smoke test manual.
app.get('/', (req, res) => {
  res.status(200).json({ success: true, data: { name: 'Nayara One API', apiPrefix } });
});

// Error handler global — deve ser o último middleware montado.
app.use(errorHandler);

// M9-D202: em produção, sem cofre de segredos configurado a API não sobe (nunca cai em .env).
require('./src/features/integrations/secrets').assertSecretStoreAtBoot();

// M9-D209: todo adapter cumpre o contrato IntegrationAdapter; contrato inválido derruba o boot (INTEGRATION_ADAPTER_CONTRACT_INVALID).
const registeredAdapters = require('./src/features/integrations/adapters').registerBuiltInAdapters();
logger.info({ adapters: registeredAdapters }, `Adapters de integração registrados: ${registeredAdapters.length}`);

if (process.env.NODE_ENV !== 'test') {
// M9-D214: o Dispatch Service é quem recebe do outbox os eventos com destino externo (1 evento = 1 envio PENDING, na transação do despacho).
// M9-D218: as tentativas de envio alimentam a saúde dos fornecedores (chamadas, latência, limite, credencial, fila morta e cota).
require('./src/features/integrations/dispatch').registerDispatchHealthSource();
// M9-D224: a caixa de entrada de webhooks completa a saúde (fila de eventos e fila morta).
require('./src/features/integrations/health/inboxSample').registerInboxHealthSource();
require('./src/features/integrations/dispatch').installOutboxEnqueuer();

  runMigrationsOnBoot();
  // M9-D016: o registro de tools da NAY confere cada definição contra core.permissions; definição inválida derruba o boot.
  require('./src/features/ai/tools').initToolRegistry()
    .then((registry) => logger.info({ tools: registry.list().length }, `Tools da NAY registradas: ${registry.list().length}`))
    .catch((err) => {
      logger.error({ err }, `Registro de tools da NAY falhou: ${err.message}`);
      // Definição inválida derruba o boot; indisponibilidade passageira do banco não (o registro é montado de novo no primeiro uso).
      if (err.code === 'AI_TOOL_DEFINITION_INVALID') process.exit(1);
    });
}

const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  logger.info({ port, apiPrefix }, `Nayara One API ouvindo na porta ${port} (prefixo ${apiPrefix})`);
});
app.server = server;

// Job periódico de matching do Radar — não roda em ambiente de teste (evita efeitos
// colaterais/timers pendurados em test runners que importam este arquivo).
if (process.env.NODE_ENV !== 'test' && process.env.RADAR_MATCHING_JOB_DISABLED !== 'true') {
  startRadarMatchingJob();
}

// Ciclo de vida das campanhas de Marketing (M9-D412): inicia, encerra e dispara os steps, a cada minuto.
if (process.env.NODE_ENV !== 'test' && process.env.CAMPAIGN_LIFECYCLE_JOB_DISABLED !== 'true') {
  startCampaignLifecycleJob();
}

// Rascunhos dos tipos de conteúdo do Marketing (M9-D409): aniversário diário (08:00 de Brasília) e marco público das obras.
if (process.env.NODE_ENV !== 'test' && process.env.MARKETING_CONTENT_TYPES_JOB_DISABLED !== 'true') {
  startMarketingContentTypesJob();
}

// Varredura diária do Calendário nas fontes de obras e garantias (M9-D803), na hora configurada (padrão 06:00 de Brasília).
if (process.env.NODE_ENV !== 'test' && process.env.CALENDAR_BACKFILL_JOB_DISABLED !== 'true') {
  startCalendarBackfillJob();
}

// Despachante do Outbox (TEC-06/TEC-07) — existia desde antes mas nunca era chamado por nada;
// Alertas do Calendário (M9-D802): itens vencidos (diário, 06:00 de Brasília) e conflito de agenda (a cada 15 min); ambos leem só calendar_items.
if (process.env.NODE_ENV !== 'test' && process.env.CALENDAR_OVERDUE_JOB_DISABLED !== 'true') {
  startCalendarOverdueJob();
}
if (process.env.NODE_ENV !== 'test' && process.env.CALENDAR_CONFLICT_JOB_DISABLED !== 'true') {
  startCalendarConflictJob();
}

// todo evento gravado ficava PENDING para sempre. Roda a cada 30s dentro do próprio processo.
if (process.env.NODE_ENV !== 'test' && process.env.OUTBOX_DISPATCHER_JOB_DISABLED !== 'true') {
  startOutboxDispatcherJob();
}

// Alertas de prazos jurídicos (reportado pela cliente 14/09/2026 — "prazos e alertas
// efetivamente utilizáveis"). Roda a cada 30 min dentro do próprio processo.
if (process.env.NODE_ENV !== 'test' && process.env.LEGAL_DEADLINE_ALERT_JOB_DISABLED !== 'true') {
  startLegalDeadlineAlertJob();
}

// GAP REAL CORRIGIDO (varredura proativa, 09/10/2026 — mesma classe de bug encontrada pela
// auditoria externa em missingDailyReportJob): existe desde 17/09/2026 com testes
// (test/legal.guaranteeExpiry.test.js), mas nunca foi iniciado aqui — a rotina de alerta de
// vencimento de garantia (fiança/seguro-fiança/caução) nunca rodava sozinha no ambiente
// publicado.
if (process.env.NODE_ENV !== 'test' && process.env.LEGAL_GUARANTEE_EXPIRY_ALERT_JOB_DISABLED !== 'true') {
  startLegalGuaranteeExpiryAlertJob();
}

// Escalonamento de reclamações/elogios/conflitos com SLA vencido (M3-20, 18/09/2026).
if (process.env.NODE_ENV !== 'test' && process.env.FEEDBACK_CASE_ALERT_JOB_DISABLED !== 'true') {
  startFeedbackCaseAlertJob();
}

// Escalonamento de tarefas de CRM vencidas (crm.task.overdue) — item 5 do ciclo de auditoria
// externa Marco 3 (Guia do Marcelo §11 "Tarefa vencida escala conforme regra.").
if (process.env.NODE_ENV !== 'test' && process.env.CRM_TASK_OVERDUE_JOB_DISABLED !== 'true') {
  startCrmTaskOverdueJob();
}

// Billing mensal automático de locação (auditoria externa Nayara, 11/10/2026: "Billing mensal
// automático... não foi encontrado — apenas lançamentos financeiros avulsos"). Gera o
// cronograma de cobrança (componente RENT, pelo valor vigente após reajuste) de toda
// competência ainda não gerada para contratos de locação ACTIVE — 1x por dia.
if (process.env.NODE_ENV !== 'test' && process.env.BILLING_SCHEDULE_AUTO_GENERATE_JOB_DISABLED !== 'true') {
  startBillingScheduleAutoGenerateJob();
}

// Régua de cobrança de locação (REG-LOC-004, conferência Nayara 18/10/2026: "cadência via Motor
// de Regras"). Lembrete antes do vencimento, avisos e tarefas de atraso, escalonamento para
// avaliação jurídica — só efeitos internos (Notification/Task/outbox). Roda a cada 1h.
if (process.env.NODE_ENV !== 'test' && process.env.COLLECTION_CADENCE_JOB_DISABLED !== 'true') {
  startCollectionCadenceJob();
}

// Escalonamento de SLA dos chamados de garantia/pós-obra (M6-63/M6-88). Roda a cada 30 min
// dentro do próprio processo, mesmo padrão de feedbackCaseAlertJob.
if (process.env.NODE_ENV !== 'test' && process.env.WARRANTY_ESCALATION_JOB_DISABLED !== 'true') {
  startWarrantyEscalationJob();
}

// Detecção de atraso de obra (M6-74). Roda a cada 1h dentro do próprio processo, mesmo padrão
// do job de escalonamento de garantia acima.
if (process.env.NODE_ENV !== 'test' && process.env.PROJECT_DELAY_DETECTION_JOB_DISABLED !== 'true') {
  startProjectDelayDetectionJob();
}

// GAP REAL CORRIGIDO (auditoria externa Nayara, reteste 09/10/2026 — F3): o job existia e tinha
// testes (missingDailyReportJob.js, test/construction.missingDailyReport.test.js) desde
// 02/10/2026, mas nunca foi iniciado aqui — a rotina de "ausência de diário gera tarefa"
// (contrato Caderno p.161) nunca rodava sozinha no ambiente publicado, só quando chamada
// diretamente em teste. Mesmo padrão dos jobs acima.
if (process.env.NODE_ENV !== 'test' && process.env.MISSING_DAILY_REPORT_JOB_DISABLED !== 'true') {
  startMissingDailyReportJob();
}

// Escalonamento de empréstimo de ferramenta vencido (Marco 7 — EST-TS-13). Mesmo padrão dos
// jobs acima.
if (process.env.NODE_ENV !== 'test' && process.env.TOOL_LOAN_OVERDUE_JOB_DISABLED !== 'true') {
  startToolLoanOverdueJob();
}

// Alerta de renovação de apólice de seguro (Marco 7 — Insurance Hub, "renovação alerta" no
// contrato). Gap real achado em auditoria 2026-10-05: a tarefa era criada mas nunca lida por
// nada. Mesmo padrão dos jobs acima.
if (process.env.NODE_ENV !== 'test' && process.env.INSURANCE_RENEWAL_ALERT_JOB_DISABLED !== 'true') {
  startInsuranceRenewalAlertJob();
}

// Vencimento de apólice de seguro (Marco 7 — Insurance Hub, "vigência" no contrato). Gap real
// achado em auditoria 2026-10-07: só existia o alerta de renovação, nada transicionava a apólice
// para EXPIRED quando a vigência acabava. A trava de sinistro novo em apólice vencida fica em
// insurance.service.js#openClaim (checa a data); este job dá visibilidade/status. Mesmo padrão
// dos jobs acima.
if (process.env.NODE_ENV !== 'test' && process.env.INSURANCE_POLICY_EXPIRY_JOB_DISABLED !== 'true') {
  startInsurancePolicyExpiryJob();
}

// Expiração de documento do Correspondente gera novo requirement automaticamente (Marco 8,
// Caderno: "Documento substituído preserva versão anterior; expiração gera requirement."). Mesmo
// padrão dos jobs acima.
if (process.env.NODE_ENV !== 'test' && process.env.CASE_DOCUMENT_EXPIRY_JOB_DISABLED !== 'true') {
  startCaseDocumentExpiryJob();
}

// Worker assíncrono de submissão/avaliação do Correspondente (Marco 8, Caderno: "Worker chama
// provider"). Os endpoints HTTP (POST .../submissions, POST .../appraisals) só persistem o
// registro como PENDING/REQUESTED e devolvem na hora — estes jobs chamam o adapter de verdade
// fora do ciclo de vida do request. Mesmo padrão dos jobs acima.
if (process.env.NODE_ENV !== 'test' && process.env.CORRESPONDENT_SUBMISSION_WORKER_DISABLED !== 'true') {
  startCorrespondentSubmissionWorkerJob();
}
if (process.env.NODE_ENV !== 'test' && process.env.CORRESPONDENT_APPRAISAL_WORKER_DISABLED !== 'true') {
  startCorrespondentAppraisalWorkerJob();
}
if (process.env.NODE_ENV !== 'test' && process.env.CORRESPONDENT_STATUS_POLL_DISABLED !== 'true') {
  startCorrespondentStatusPollJob();
}

// B2 — reconciliação de pagamentos com resposta incerta do banco (revisão 18/10/2026).
if (process.env.NODE_ENV !== 'test' && process.env.BANK_PAYMENT_RECONCILIATION_JOB_DISABLED !== 'true') {
  startBankPaymentReconciliationJob();
}

// Marco 9, M9-D206 — saúde dos fornecedores: janelas de 5 min, 1 h e 1 dia e linha atual por connection ACTIVE.
if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_HEALTH_AGGREGATE_JOB_DISABLED !== 'true') {
  startIntegrationHealthAggregateJob();
  startAiRetentionJob();
  startAiEvaluationJob();
  startAiBudgetPeriodJob();
  startAiMemoryExpiryJob();
  startAiRagJob();
  startAnalyticsReadModelRefreshJob();
  startAnalyticsMaterializedViewJob(); // M9-D698: refresh concorrente das materialized views do BI
  startAnalyticsSnapshotJob(); // M9-D609: snapshot diário dos KPIs (D-1, 00:30 de São Paulo) com catch-up
}

// Marco 9, M9-D223 — teste de saúde ativo de cada fornecedor com connection ACTIVE, a cada integration.health.check_interval_s.
if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_HEALTH_CHECK_JOB_DISABLED !== 'true') {
  startIntegrationHealthCheckJob();
}

// Marco 9, M9-D224 — alertas das integrações (fora do ar, aumento de erro, credencial, sync parado e cota), a cada integration.alert.evaluate_interval_s.
if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_ALERT_JOB_DISABLED !== 'true') {
  startIntegrationAlertJob();
}

// Marco 9, M9-D248 — auditoria diária das dependências de produção (SDK_VULNERABILITY em integration_errors e aviso).
if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_DEPENDENCY_AUDIT_JOB_DISABLED !== 'true') {
  startDependencyAuditJob();
}

// Marco 9, M9-D244 — retenção das tabelas de integração por integration.purge_expired() (o runtime não tem DELETE).
if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_RETENTION_JOB_DISABLED !== 'true') {
// Marco 9, M9-D214 — worker dos envios a fornecedores (PENDING/RETRY_WAIT -> SENDING -> SUBMITTED/CONFIRMED), a cada integration.dispatch.worker_interval_s.
if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_DISPATCH_WORKER_JOB_DISABLED !== 'true') {
  startIntegrationDispatchWorkerJob();
}

  startIntegrationRetentionJob();
}

module.exports = app;
