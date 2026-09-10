'use strict';

/**
 * metrics — TEC-13 (homologação 10/09/2026): não existia nenhuma métrica exposta pela API.
 * `prom-client` expõe um endpoint `/api/metrics` em formato Prometheus (texto plano padrão da
 * indústria) — qualquer coletor (Prometheus, Grafana Cloud, Better Stack etc.) sabe ler esse
 * formato direto, sem código adicional.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: isto expõe as métricas, mas NÃO inclui
 * nenhum serviço que as colete/armazene/alerte (isso exigiria provisionar Prometheus+Grafana
 * ou contratar um serviço externo — decisão de infraestrutura/custo que cabe à cliente).
 * `/api/metrics` funciona sozinho para inspeção manual (`curl`) mesmo sem nenhum coletor.
 */
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'nayaraone_api_' });

const httpRequestDuration = new client.Histogram({
  name: 'nayaraone_api_http_request_duration_seconds',
  help: 'Duração das requisições HTTP em segundos, por método/rota/status',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const outboxPendingGauge = new client.Gauge({
  name: 'nayaraone_api_outbox_pending_events',
  help: 'Quantidade de eventos PENDING no Outbox no momento da última leitura',
  registers: [register],
});

const outboxDeadLetterGauge = new client.Gauge({
  name: 'nayaraone_api_outbox_dead_letter_events',
  help: 'Quantidade de eventos em DEAD_LETTER no Outbox no momento da última leitura',
  registers: [register],
});

module.exports = { register, httpRequestDuration, outboxPendingGauge, outboxDeadLetterGauge };
