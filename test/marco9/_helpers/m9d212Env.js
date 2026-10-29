'use strict';

// Apoio dos testes do intake de webhooks (M9-D212 e M9-D213): evento de status assinado, rodada do worker e leitura da caixa de entrada, do outbox e dos erros.
// Roda em banco descartável (os testes COMMITAM). Quem usa define process.env.PORT ANTES de requerer este arquivo (ele sobe o app de teste).
const env = require('./m9d211Env');
const { runIntakeCycle } = require('../../../src/features/integrations/webhooks/worker');

const { sql, comTenant, ctxDe, uniqueSuffix } = env;

/** Evento de status do sandbox de mensageria (cumpre o esquema statusEventSchemas). */
const evento = (extra = {}) => ({ id: `evt-${uniqueSuffix()}`, type: 'message.status', api_version: 'v1', resourceId: `res-${uniqueSuffix()}`, status: 'SENT', ...extra });

/** POST do evento assinado (corpo exato = JSON do objeto). `opts`: t (segundos do horário assinado), headers extras. */
function enviar(canal, obj, opts = {}) {
  const corpo = Buffer.isBuffer(obj) ? obj : Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const assinatura = env.assinar(canal.segredo, corpo, opts.t === undefined ? {} : { t: opts.t });
  return env.postar(`/v1/webhooks/${canal.provider}/${canal.canal}`, corpo, { ...assinatura, ...(opts.headers || {}) });
}

const rodar = (tenant) => runIntakeCycle(ctxDe(tenant));
const linha = async (tenant, provider, id) => (await env.inbox(tenant, provider, id))[0];
const outboxDe = (tenant, inboxId) => sql(tenant, "SELECT * FROM integration.outbox_events WHERE aggregate_type = 'IntegrationWebhookEvent' AND aggregate_id = :id", { id: inboxId });
const vencer = (tenant, inboxId) => sql(tenant, "UPDATE integration.webhook_inbox SET next_attempt_at = now() - interval '1 second' WHERE id = :id", { id: inboxId });
const antigo = (tenant, inboxId, dias) => sql(tenant, 'UPDATE integration.webhook_inbox SET received_at = now() - make_interval(days => :d) WHERE id = :id', { id: inboxId, d: dias });

module.exports = { ...env, evento, enviar, rodar, linha, outboxDe, vencer, antigo, comTenant };
