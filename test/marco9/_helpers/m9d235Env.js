'use strict';

// Apoio dos testes do e-mail recebido (M9-D235): evento `email.received` assinado do sandbox, rodada do worker e leitura das tabelas do inbound. Banco descartável (os testes COMMITAM).
// Quem usa define process.env.PORT ANTES de requerer este arquivo.
const crypto = require('node:crypto');
const env = require('./m9d234Env');
const F = require('./m9d247Files');

const { sql, uniqueSuffix } = env;

const anexo = (fileName, buffer, contentType) => ({ fileName, contentType, contentBase64: buffer.toString('base64') });
/** PDF limpo único (o hash entra na idempotência da quarentena). */
const pdfLimpo = (nome = `comprovante-${uniqueSuffix()}.pdf`) => anexo(nome, Buffer.concat([F.pdf(), Buffer.from(`\n%u${uniqueSuffix()}${crypto.randomBytes(4).toString('hex')}`)]), 'application/pdf');
const pdfInfectado = (nome = `virus-${uniqueSuffix()}.pdf`) => anexo(nome, Buffer.concat([F.pdfInfectado(), Buffer.from(`\n%u${uniqueSuffix()}`)]), 'application/pdf');

/** Evento do provedor com o e-mail recebido (formato do sandbox). `message` sobrescreve campos da mensagem. */
const recebido = (message = {}, extra = {}) => ({
  id: `evt-in-${uniqueSuffix()}`, type: 'email.received', api_version: 'v1',
  message: { id: `sbx-in-${uniqueSuffix()}`, from: 'cliente@qa-m9.test', to: ['atendimento@qa-m9.test'], subject: 'Documentos', text: 'Segue o documento pedido.', attachments: [], ...message },
  ...extra,
});

/** Entrega o evento pela rota de webhooks e roda o worker da caixa de entrada. */
async function receber(canal, tenant, message, extra) {
  const evt = recebido(message, extra);
  const r = await env.enviar(canal, evt);
  await env.rodar(tenant);
  return { evt, resposta: r, externalId: evt.message.id };
}
const mensagemIn = async (tenant, externalId) => (await sql(tenant, 'SELECT * FROM integration.email_inbound_messages WHERE company_id = :c AND external_message_id = :x', { c: tenant.companyId, x: externalId }))[0];
const anexosIn = (tenant, messageId) => sql(tenant, 'SELECT a.*, q.status AS quarantine_status FROM integration.email_inbound_attachments a LEFT JOIN files.quarantine q ON q.id = a.quarantine_id WHERE a.message_id = :m ORDER BY a.position', { m: messageId });

module.exports = { ...env, F, anexo, pdfLimpo, pdfInfectado, recebido, receber, mensagemIn, anexosIn };
