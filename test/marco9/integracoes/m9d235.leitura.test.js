'use strict';

// Marco 9, M9-D235 — e-mail recebido pela leitura periódica (cursor retomável) e pelos parâmetros do administrador (prefixos, limite de anexos, verificação na chegada). Banco descartável.
process.env.PORT = process.env.M9D235_LEITURA_PORT || '24237';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d235Env');
const inbound = require('../../../src/features/integrations/email/inbound');
const store = require('../../../src/features/integrations/providers/email/sandbox/email.sandbox.store');

let tenant;
let desligarCofre;
let canal;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  canal = await env.conectar(tenant);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const grupoEmpresa = () => ({ group: { id: tenant.groupId }, company: { id: tenant.companyId }, connectionId: canal.conn.id });

test('inbound_leitura_periodica_usa_o_mesmo_pipeline_e_o_cursor_nao_repete', async () => {
  const a = { id: `sbx-poll-${env.uniqueSuffix()}`, from: 'a@qa-m9.test', subject: 'CPF 123.456.789-09', text: 'Texto A', attachments: [env.pdfLimpo()] };
  const b = { id: `sbx-poll-${env.uniqueSuffix()}`, from: 'b@qa-m9.test', subject: 'Sem anexo', text: 'Texto B' };
  store.injectInbound(canal.conn.id, a);
  store.injectInbound(canal.conn.id, b);
  const r1 = await inbound.pollInboundEmail(grupoEmpresa());
  assert.equal(r1.status, 'IDLE');
  assert.equal(r1.written, 2);
  const ma = await env.mensagemIn(tenant, a.id);
  assert.equal(ma.contains_pii, true, 'a leitura passa pelo mesmo mascaramento do webhook');
  assert.equal((await env.anexosIn(tenant, ma.id))[0].status, 'CLEAN');
  assert.ok(await env.mensagemIn(tenant, b.id));
  // Segunda leitura: o cursor já avançou, nada se repete.
  const r2 = await inbound.pollInboundEmail(grupoEmpresa());
  assert.equal(r2.written, 0);
  const c = { id: `sbx-poll-${env.uniqueSuffix()}`, from: 'c@qa-m9.test', subject: 'Nova', text: 'Texto C' };
  store.injectInbound(canal.conn.id, c);
  assert.equal((await inbound.pollInboundEmail(grupoEmpresa())).written, 1);
  assert.equal((await env.sql(tenant, 'SELECT count(*)::int AS n FROM integration.email_inbound_messages WHERE connection_id = :c', { c: canal.conn.id }))[0].n, 3);
});

test('inbound_parametros_do_administrador_valem', async () => {
  // Prefixo da referência vem da configuração: com "CASO" a referência [PROC-x] deixa de valer e [CASO-x] passa a valer.
  const enviada = await env.enviarEEntregarAoProvedor(tenant, { origin: { type: 'FINANCING_CASE', id: `fc-${env.uniqueSuffix()}` } });
  const id = enviada.message.origin_id;
  await env.config(tenant, 'integration.email.inbound_reference_prefixes', 'CASO');
  try {
    const { externalId: velha } = await env.receber(canal, tenant, { subject: `[PROC-${id}] oi` });
    assert.equal((await env.mensagemIn(tenant, velha)).link_status, 'UNLINKED');
    const { externalId: nova } = await env.receber(canal, tenant, { subject: `[CASO-${id}] oi` });
    assert.equal((await env.mensagemIn(tenant, nova)).link_status, 'LINKED');
  } finally { await env.config(tenant, 'integration.email.inbound_reference_prefixes', 'PROC'); }
  // Limite de anexos: o excedente fica bloqueado, sem conteúdo guardado.
  await env.config(tenant, 'integration.email.inbound_max_attachments', 1);
  try {
    const { externalId } = await env.receber(canal, tenant, { attachments: [env.pdfLimpo(), env.pdfLimpo()] });
    const anexos = await env.anexosIn(tenant, (await env.mensagemIn(tenant, externalId)).id);
    assert.deepEqual(anexos.map((x) => x.status), ['CLEAN', 'BLOCKED']);
    assert.equal(anexos[1].quarantine_id, null);
  } finally { await env.config(tenant, 'integration.email.inbound_max_attachments', 20); }
  // Corpo máximo: o excedente é cortado antes de guardar.
  await env.config(tenant, 'integration.email.inbound_body_max_chars', 100);
  try {
    const { externalId } = await env.receber(canal, tenant, { text: 'x'.repeat(500) });
    assert.equal((await env.mensagemIn(tenant, externalId)).body_masked.length, 100);
  } finally { await env.config(tenant, 'integration.email.inbound_body_max_chars', 20000); }
  // Valor inválido é recusado pela configuração.
  await assert.rejects(env.config(tenant, 'integration.email.inbound_reference_prefixes', 'a b;c'), /prefixos|SETTING_INVALID_VALUE|inválid/i);
});

test('inbound_job_le_so_connection_em_modo_poll_no_intervalo_configurado', async () => {
  const { runEmailInboundPollJob, resetPollSchedule } = require('../../../src/engines/jobs/emailInboundPollJob');
  const msg = { id: `sbx-job-${env.uniqueSuffix()}`, from: 'job@qa-m9.test', subject: 'Pelo job', text: 'Texto' };
  store.injectInbound(canal.conn.id, msg);
  resetPollSchedule();
  // Connection que recebe por webhook (sem inboundMode): o job não a lê.
  await runEmailInboundPollJob();
  assert.equal(await env.mensagemIn(tenant, msg.id), undefined);
  // Em modo POLL ela é lida; dentro do intervalo configurado o job não volta a ler.
  await env.sql(tenant, "UPDATE integration.connections SET config_json = config_json || '{\"inboundMode\":\"POLL\"}'::jsonb WHERE id = :id", { id: canal.conn.id });
  resetPollSchedule();
  const r = await runEmailInboundPollJob();
  assert.ok(r.connections >= 1 && r.received >= 1);
  assert.ok(await env.mensagemIn(tenant, msg.id));
  const depois = { id: `sbx-job-${env.uniqueSuffix()}`, from: 'job@qa-m9.test', subject: 'Depois', text: 'Texto' };
  store.injectInbound(canal.conn.id, depois);
  await runEmailInboundPollJob();
  assert.equal(await env.mensagemIn(tenant, depois.id), undefined, 'ainda dentro do intervalo de 5 minutos');
  await env.config(tenant, 'integration.email.inbound_poll_interval_min', 1);
  try {
    resetPollSchedule();
    await runEmailInboundPollJob();
    assert.ok(await env.mensagemIn(tenant, depois.id));
  } finally { await env.config(tenant, 'integration.email.inbound_poll_interval_min', 5); }
});
