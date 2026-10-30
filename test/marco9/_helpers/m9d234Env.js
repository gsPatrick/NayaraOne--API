'use strict';

// Apoio dos testes do e-mail de saída (M9-D234): connection de e-mail com canal e segredo do webhook, arquivos com antivírus e classificação, envio pelo serviço,
// rodada do worker de envios e eventos assinados do provedor. Roda em banco descartável (os testes COMMITAM). Quem usa define process.env.PORT ANTES de requerer este arquivo.
const env = require('./m9d212Env');
const settingsService = require('../../../src/features/settings/settings.service');
const { File } = require('../../../src/models');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { runDispatchCycle } = require('../../../src/features/integrations/dispatch/worker');
const emailFlow = require('../../../src/features/integrations/email');

const { comTenant, sql, uniqueSuffix, ctxDe } = env;

/** Canal ATIVO do e-mail de laboratório da empresa (outros canais ativos do mesmo fornecedor ficam pausados), com o segredo do webhook no cofre. */
async function conectar(tenant, providerCode = 'email-sandbox', { config } = {}) {
  await sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE'", { c: tenant.companyId, p: providerCode });
  const canal = await env.criarCanal(tenant, { provider: providerCode });
  if (config) await sql(tenant, 'UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb) WHERE id = :id', { id: canal.conn.id, cfg: JSON.stringify(config) });
  await comTenant(tenant, (t) => transitionConnection(canal.conn.id, 'ACTIVE', ctxDe(tenant), t));
  return canal;
}

/** Quem envia: o usuário do teste com as permissões informadas (o arquivo é lido pelo dono do upload, por categoria ou por permissão do módulo). */
const authDe = (tenant, extra = {}) => ({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: [], ...extra });

/** Arquivo da empresa já enviado pelo usuário do teste. `scan`: CLEAN (padrão) ou outro; `classificacao`: nula até alguém classificar. */
async function criarArquivo(tenant, { nome = `anexo-${uniqueSuffix()}.pdf`, mime = 'application/pdf', bytes = 1024, scan = 'CLEAN', classificacao = 'INTERNAL', uploader } = {}) {
  return comTenant(tenant, (t) => File.create({
    groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `qa-m9/email/${uniqueSuffix()}-${nome}`, fileName: nome, mimeType: mime, sizeBytes: bytes,
    checksumSha256: String(uniqueSuffix()).padEnd(64, 'a').slice(0, 64), scanStatus: scan, classification: classificacao, uploadedByUserId: uploader || tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: t }));
}

const config = (tenant, chave, valor) => comTenant(tenant, (t) => settingsService.upsertSetting(chave, valor, tenant, tenant.userId, t));

/** Envia pelo serviço (commit). `extra` sobrescreve os campos padrão. */
function enviarEmail(tenant, extra = {}) {
  return comTenant(tenant, (t) => emailFlow.sendEmail(ctxDe(tenant), {
    auth: authDe(tenant), to: [`dest-${uniqueSuffix()}@qa-m9.test`], subject: 'Segunda via do boleto', bodyText: 'Segue a segunda via do boleto de aluguel.', purpose: 'COBRANCA', ...extra,
  }, t));
}

/** Rodadas do worker de envios (chama o provedor) até a fila vencida esvaziar: outros testes do mesmo banco deixam envios na fila, e cada rodada pega no máximo `worker_batch_size`. */
async function rodarEnvios(tenant) {
  let total = { claimed: 0, sent: 0 };
  for (let i = 0; i < 30; i += 1) {
    const r = await runDispatchCycle(ctxDe(tenant));  
    total = { claimed: total.claimed + r.claimed, sent: total.sent + r.sent };
    if (r.claimed === 0) break;
  }
  return total;
}
const mensagem = async (tenant, id) => (await sql(tenant, 'SELECT * FROM integration.email_messages WHERE id = :id', { id }))[0];
const eventosDe = (tenant, id) => sql(tenant, 'SELECT * FROM integration.email_message_events WHERE message_id = :id ORDER BY created_at, id', { id });
const envio = async (tenant, id) => (await sql(tenant, 'SELECT * FROM integration.dispatches WHERE id = :id', { id }))[0];

/** Evento do provedor (formato do sandbox). `tipo`: delivered, bounced, complained, failed. */
const evento = (tipo, messageId, extra = {}) => ({ id: `evt-em-${uniqueSuffix()}`, type: `email.${tipo}`, api_version: 'v1', message: { id: messageId }, ...extra });

/** Envia a mensagem, roda o worker e devolve a mensagem já com o identificador do provedor (estado SENT). */
async function enviarEEntregarAoProvedor(tenant, extra) {
  const r = await enviarEmail(tenant, extra);
  await rodarEnvios(tenant);
  return { ...r, message: await mensagem(tenant, r.message.id) };
}

module.exports = { ...env, conectar, authDe, criarArquivo, config, enviarEmail, rodarEnvios, mensagem, eventosDe, envio, evento, enviarEEntregarAoProvedor, emailFlow };
