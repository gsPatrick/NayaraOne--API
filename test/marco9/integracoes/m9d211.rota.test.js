'use strict';

// Marco 9, M9-D211 — rota pública única de webhooks: aceite, corpo bruto, assinatura antes de ler o JSON, canal desconhecido, verificador ausente,
// tenant pela connection, janela de graça, fila morta com 200 e alias da raiz. HTTP real em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D211_ROTA_PORT || '21211';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d211Env');
const settingsService = require('../../../src/features/settings/settings.service');
const { getSecretStore, webhookRefOf } = require('../../../src/features/integrations/secrets');
const { signatureFailuresCount } = require('../../../src/features/integrations/webhooks/webhooks.metrics');

let tenant;
let outro;
let desligarCofre;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const novoId = () => `evt-d211-${env.uniqueSuffix()}`;

before(async () => {
  const t = await env.carregarTenants();
  tenant = t.tenant;
  outro = t.outro;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const caminho = (c) => `/v1/webhooks/${c.provider}/${c.canal}`;
const enviar = (c, corpo, extra = {}) => {
  const bruto = Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo, 'utf8');
  return env.postar(caminho(c), bruto, { ...env.assinar(c.segredo, bruto), ...extra });
};

test('webhook_aceito_e_persistido_com_200', async () => {
  const c = await env.criarCanal(tenant);
  assert.match(c.canal, /^[A-Za-z0-9_-]{24,48}$/, 'o canal é um token opaco gerado pelo servidor');
  const id = novoId();
  const corpo = `{"id":"${id}","type":"payment.paid"}`;
  const r = await enviar(c, corpo);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 'accepted', eventId: id });
  const [linha] = await env.inbox(tenant, c.provider, id);
  assert.ok(linha, 'a linha entrou na caixa de entrada');
  assert.equal(linha.status, 'RECEIVED');
  assert.equal(linha.company_id, tenant.companyId, 'a empresa vem da connection do canal');
  assert.equal(linha.connection_id, c.conn.id);
  assert.equal(linha.channel, c.canal);
  assert.equal(linha.event_type, 'payment.paid');
  assert.equal(linha.signature_valid, true);
  assert.equal(Buffer.compare(linha.payload_raw, Buffer.from(corpo)), 0, 'o corpo bruto exato foi guardado');
  const repetido = await enviar(c, corpo);
  assert.deepEqual([repetido.status, repetido.json], [200, { status: 'duplicate', eventId: id }], 'o mesmo evento não grava segunda linha');
  assert.equal((await env.inbox(tenant, c.provider, id)).length, 1);
});

test('webhook_assinatura_antes_de_parse', async () => {
  const c = await env.criarCanal(tenant);
  const lixo = Buffer.from('{isto nao e json');
  const r = await env.postar(caminho(c), lixo, { 'x-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
  assert.equal(r.status, 401, 'corpo ilegível com assinatura inválida é 401, nunca 400: o parse nem é tentado');
  assert.equal(r.json.error.code, 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID');
  assert.equal(r.json.error.message, 'Assinatura inválida.');
  const semCabecalho = await env.postar(caminho(c), lixo);
  assert.equal(semCabecalho.status, 401);
});

test('webhook_corpo_bruto_exato', async () => {
  const c = await env.criarCanal(tenant);
  const id = novoId();
  const original = `{"id":"${id}","type":"a.b","valor":"10.00"}`;
  const reordenado = `{"type":"a.b","id":"${id}","valor":"10.00"}`;
  const assinatura = env.assinar(c.segredo, original);
  const alterado = await env.postar(caminho(c), Buffer.from(reordenado), assinatura);
  assert.equal(alterado.status, 401, 'o mesmo JSON com as chaves em outra ordem tem outros bytes e não passa');
  const umByte = await env.postar(caminho(c), Buffer.from(original.replace('10.00', '10.01')), assinatura);
  assert.equal(umByte.status, 401, 'um byte alterado muda a assinatura inteira');
  const certo = await env.postar(caminho(c), Buffer.from(original), assinatura);
  assert.equal(certo.status, 200);
});

test('webhook_canal_desconhecido_resposta_generica', async () => {
  const c = await env.criarCanal(tenant);
  const corpo = Buffer.from('{"id":"x","type":"t.e"}');
  const alvos = [
    `/v1/webhooks/messaging-sandbox/${'x'.repeat(32)}`, // canal inexistente de fornecedor que existe
    `/v1/webhooks/fornecedor-que-nao-existe/${'y'.repeat(32)}`, // fornecedor inexistente
    `/v1/webhooks/${c.provider}/curto`, // canal fora do formato
    `/v1/webhooks/portal-sandbox/${c.canal}`, // canal de outro fornecedor
  ];
  const respostas = [];
  for (const alvo of alvos) respostas.push(await env.postar(alvo, corpo, env.assinar('qualquer', corpo)));
  respostas.forEach((r) => {
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'INTEGRATION_WEBHOOK_UNKNOWN_CHANNEL');
    assert.equal(r.json.error.message, 'Canal de webhook desconhecido.');
  });
  assert.equal(new Set(respostas.map((r) => JSON.stringify([r.status, r.json.error.code, r.json.error.message]))).size, 1, 'a resposta é idêntica para fornecedor e canal inexistentes');
});

test('webhook_canal_desconhecido_registra_contador_sem_payload', async () => {
  const antes = await env.desconhecidos('messaging-sandbox');
  const segredoNoCorpo = `corpo-secreto-${env.uniqueSuffix()}`;
  const r = await env.postar(`/v1/webhooks/messaging-sandbox/${'z'.repeat(30)}`, Buffer.from(`{"x":"${segredoNoCorpo}"}`), {});
  assert.equal(r.status, 404);
  assert.equal(await env.desconhecidos('messaging-sandbox'), antes + 1, 'recordUnknownWebhook conta a chamada por fornecedor do catálogo');
  const lixo = await env.postar(`/v1/webhooks/inventado-${env.uniqueSuffix()}/${'z'.repeat(30)}`, Buffer.from('{}'), {});
  assert.equal(lixo.status, 404);
  const agregado = await env.sql(tenant, "SELECT 1 FROM integration.integration_errors WHERE company_id = :c AND operation = 'webhook.receive' AND message ILIKE :m", { c: tenant.companyId, m: `%${segredoNoCorpo}%` });
  assert.equal(agregado.length, 0, 'o corpo nunca é gravado: sem empresa não há linha em integration_errors');
});

test('webhook_sem_verifier_recusado', async () => {
  const c = await env.criarCanal(tenant, { provider: 'analytics-sandbox' });
  const id = novoId();
  const corpo = `{"id":"${id}","type":"t.e"}`;
  const r = await enviar(c, corpo);
  assert.equal(r.status, 501, 'fornecedor sem verificador nunca é aceito');
  assert.equal(r.json.error.code, 'INTEGRATION_WEBHOOK_NO_VERIFIER');
  assert.equal(r.json.error.message, 'Este fornecedor não tem verificador de assinatura.');
  assert.equal((await env.inbox(tenant, c.provider, id)).length, 0);
});

test('webhook_tenant_vem_da_connection', async (t) => {
  if (!outro) return t.skip('empresa B do seed ausente');
  const c = await env.criarCanal(tenant);
  const proprio = novoId();
  const ok = await enviar(c, `{"id":"${proprio}","type":"a.b"}`);
  assert.equal(ok.status, 200);
  assert.equal((await env.inbox(tenant, c.provider, proprio))[0].company_id, tenant.companyId);
  const corpo = `{"id":"${novoId()}","company_id":"${outro.companyId}","type":"a.b"}`;
  const r = await enviar(c, corpo);
  assert.deepEqual([r.status, r.json], [200, { status: 'rejected_to_dlq' }], 'o corpo que cita outra empresa é rejeitado, sem 4xx');
  const dela = await env.sql(tenant, "SELECT status, dead_letter_reason, payload_raw FROM integration.webhook_inbox WHERE connection_id = :id AND status = 'DEAD_LETTER'", { id: c.conn.id });
  assert.equal(dela.length, 1);
  assert.equal(dela[0].payload_raw, null, 'o conteúdo do evento rejeitado não fica guardado');
  const naOutra = await env.sql(outro, 'SELECT 1 FROM integration.webhook_inbox WHERE connection_id = :id', { id: c.conn.id });
  assert.equal(naOutra.length, 0, 'nada entra na empresa citada no corpo');
  const erro = await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_TENANT_MISMATCH');
  assert.equal(erro[0].error_class, 'SECURITY');
});

test('webhook_assinatura_falsa_registra_erro_sem_payload', async () => {
  const c = await env.criarCanal(tenant);
  const marcador = `payload-confidencial-${env.uniqueSuffix()}`;
  const corpo = Buffer.from(`{"id":"${novoId()}","type":"t.e","nota":"${marcador}","cpf":"123.456.789-09"}`);
  const falhasAntes = await signatureFailuresCount(c.provider);
  const r = await env.postar(caminho(c), corpo, env.assinar('segredo-errado', corpo));
  assert.equal(r.status, 401);
  const [erro] = await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID');
  assert.ok(erro, 'a rejeição fica registrada');
  assert.deepEqual([erro.source, erro.error_class, erro.severity], ['WEBHOOK', 'SECURITY', 'HIGH']);
  assert.equal(erro.payload_hash, sha(corpo), 'só o hash do corpo');
  const guardado = JSON.stringify(erro);
  assert.ok(!guardado.includes(marcador) && !guardado.includes('123.456.789-09'), 'o corpo nunca é gravado');
  assert.match(erro.sanitized_payload.ipTruncated, /^(\d+\.\d+\.\d+\.x\/24|[0-9a-f:]+::\/48|desconhecido)$/i, 'IP truncado, nunca inteiro');
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(erro.sanitized_payload.ipTruncated));
  assert.equal(await signatureFailuresCount(c.provider), falhasAntes + 1, 'o contador webhook_signature_failures sobe');
});

test('webhook_janela_de_graca_segredo_antigo', async () => {
  const c = await env.criarCanal(tenant);
  const store = getSecretStore();
  const ref = webhookRefOf(c.secretRef);
  const novo = `novo-${crypto.randomBytes(8).toString('hex')}`;
  await store.put(ref, novo, { graceMs: 5 * 60 * 1000 });
  const versoes = await store.getAcceptedVersions(ref);
  assert.equal(versoes.length, 2, 'corrente e anterior (em graça)');
  const velho = await enviar(c, `{"id":"${novoId()}","type":"t.e"}`);
  assert.equal(velho.status, 200, 'a versão anterior é aceita durante a graça');
  const corpo = Buffer.from(`{"id":"${novoId()}","type":"t.e"}`);
  const comNovo = await env.postar(caminho(c), corpo, env.assinar(novo, corpo));
  assert.equal(comNovo.status, 200, 'a nova também');
  const anterior = versoes.find((v) => v.value.reveal() === c.segredo);
  await store.revoke(ref, anterior.version);
  const depois = await enviar(c, `{"id":"${novoId()}","type":"t.e"}`);
  assert.equal(depois.status, 401, 'revogada, a versão antiga deixa de valer');
});

test('webhook_payload_invalido_apos_assinatura_vai_para_dlq_com_200', async () => {
  const c = await env.criarCanal(tenant);
  const casos = [
    ['INVALID_JSON', Buffer.from('{"cpf":"123.456.789-09", isto quebra')],
    ['EVENT_ID_MISSING', Buffer.from('{"type":"a.b","email":"fulano@exemplo.com.br"}')],
    ['SCHEMA_INVALID', Buffer.from('["lista","na","raiz"]')],
  ];
  for (const [motivo, bruto] of casos) {
    const r = await enviar(c, bruto);
    assert.equal(r.status, 200, `${motivo}: nunca 4xx (o fornecedor reenviaria em laço)`);
    assert.deepEqual(r.json, { status: 'rejected_to_dlq' });
    const [linha] = await env.sql(tenant, "SELECT * FROM integration.webhook_inbox WHERE connection_id = :id AND dead_letter_reason = :m", { id: c.conn.id, m: motivo });
    assert.ok(linha, `${motivo}: linha na fila morta`);
    assert.equal(linha.status, 'DEAD_LETTER');
    assert.equal(linha.payload_raw, null);
    assert.equal(linha.payload_hash, sha(bruto));
    assert.match(linha.external_event_id, /^[0-9a-f]{64}$/, 'id derivado do fornecedor, do instante e do hash do corpo');
  }
  const erros = await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_PAYLOAD_INVALID');
  assert.equal(erros.length >= 1, true);
  const gravado = JSON.stringify(erros);
  assert.ok(!gravado.includes('123.456.789-09') && !gravado.includes('fulano@exemplo.com.br'), 'o conteúdo do erro é sanitizado');
});

test('webhook_alias_raiz_igual_ao_v1_e_ligado_por_parametro', async () => {
  const c = await env.criarCanal(tenant);
  const a = await env.postar(`/v1/webhooks/${c.provider}/${c.canal}`, Buffer.from(`{"id":"${novoId()}","type":"t.e"}`), env.assinar(c.segredo, 'x'));
  const bruto1 = Buffer.from(`{"id":"${novoId()}","type":"t.e"}`);
  const bruto2 = Buffer.from(`{"id":"${novoId()}","type":"t.e"}`);
  const comV1 = await env.postar(`/v1/webhooks/${c.provider}/${c.canal}`, bruto1, env.assinar(c.segredo, bruto1));
  const semV1 = await env.postar(`/webhooks/${c.provider}/${c.canal}`, bruto2, env.assinar(c.segredo, bruto2));
  assert.deepEqual([comV1.status, comV1.json.status], [semV1.status, semV1.json.status], 'as duas rotas respondem igual');
  assert.equal(semV1.status, 200);
  assert.equal(a.status, 401);
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('integration.webhook.alias_root_enabled', false, tenant, tenant.userId, t));
  try {
    const bruto3 = Buffer.from(`{"id":"${novoId()}","type":"t.e"}`);
    const desligado = await env.postar(`/webhooks/${c.provider}/${c.canal}`, bruto3, env.assinar(c.segredo, bruto3));
    assert.equal(desligado.status, 404, 'alias da raiz desligado pela empresa: responde como canal desconhecido');
    const aindaV1 = await env.postar(`/v1/webhooks/${c.provider}/${c.canal}`, bruto3, env.assinar(c.segredo, bruto3));
    assert.equal(aindaV1.status, 200);
  } finally {
    await env.sql(tenant, "DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.webhook.alias_root_enabled'", { c: tenant.companyId });
  }
});

test('webhook_corpo_acima_do_limite_413', async () => {
  const c = await env.criarCanal(tenant);
  const grande = Buffer.alloc(1048576 + 4096, 'a');
  const r = await env.postar(caminho(c), grande, env.assinar(c.segredo, grande));
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, 'INTEGRATION_WEBHOOK_TOO_LARGE');
});
