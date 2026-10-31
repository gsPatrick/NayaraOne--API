'use strict';

// Marco 9, M9-D236 — fornecedor incerto (UNKNOWN) que reconcilia, rota antiga do Clicksign que continua funcionando, versão do documento e troca de provider
// (signature-sandbox e signature-alt-sandbox, dois formatos de webhook, o mesmo resultado interno). Banco descartável.
process.env.PORT = process.env.M9D236_PROVIDER_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d236Env');
const settingsService = require('../../../src/features/settings/settings.service');
const contractVersionsService = require('../../../src/features/legal/contractVersions.service');
const { reconcileDispatch } = require('../../../src/features/integrations/dispatch/reconcile');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const uniqueId = () => crypto.randomBytes(6).toString('hex');
const iso = () => new Date().toISOString();

test('assinatura_timeout_envelope_unknown_reconcilia', async () => {
  const canal = await env.conectar(tenant, 'sandbox', 'signature-sandbox', { config: { sandbox_fault: 'TIMEOUT_AFTER_SEND' } });
  const contrato = await env.criarContrato(tenant);
  const sigs = await env.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
  assert.equal(sigs.length, 2, 'o pedido não falha por timeout: o envelope pode ter sido criado');
  const envelope = await env.envelopeDe(tenant, contrato.version.id);
  assert.equal(envelope.external_envelope_id, null, 'sem id do envelope enquanto o fornecedor não responde');
  const [envio] = await env.sql(tenant, 'SELECT * FROM integration.dispatches WHERE id = :id', { id: envelope.dispatch_id });
  assert.equal(envio.status, 'UNKNOWN', 'resposta incerta numa operação perigosa nunca é reenviada às cegas (D215)');
  const r = await reconcileDispatch(env.ctxDe(tenant), envio.id);
  assert.equal(r.skipped, undefined);
  const [resolvido] = await env.sql(tenant, 'SELECT * FROM integration.dispatches WHERE id = :id', { id: envio.id });
  assert.equal(['SUBMITTED', 'CONFIRMED'].includes(resolvido.status), true, `a consulta pela chave achou o envelope (${resolvido.status})`);
  assert.ok(resolvido.external_resource_id);
  const [s0] = await env.assinaturas(tenant, contrato.version.id);
  // Id do signatário no fornecedor único por rodada: o fornecedor nunca repete id, e o roteamento por id (signature_provider_routing) é global; um id fixo faria a rodada seguinte achar a assinatura da anterior.
  const idAprendido = `sbx-sig-aprendido-${uniqueId()}`;
  const ev = env.eventoA('signer.signed', { envelopeId: resolvido.external_resource_id, signer: { id: idAprendido, email: s0.signer_email, name: 'X' }, signedAt: iso(), evidence: env.EVIDENCIA });
  await env.enviar(canal, ev);
  await env.rodar(tenant);
  const depois = await env.assinaturas(tenant, contrato.version.id);
  assert.equal(depois.find((s) => s.id === s0.id).status, 'SIGNED', 'o evento casa o signatário pelo e-mail previsto');
  assert.equal(depois.find((s) => s.id === s0.id).external_signature_id, idAprendido, 'e aprende o id dele no fornecedor');
  assert.equal((await env.envelopeDe(tenant, contrato.version.id)).external_envelope_id, resolvido.external_resource_id, 'o envelope aprende o id do fornecedor pelo envio reconciliado');
});

test('assinatura_rota_clicksign_legada_funciona', async () => {
  // Sem connection ativa do Clicksign na empresa (outro teste pode ter deixado uma): o pedido cai para o sandbox, como sempre fez sem credencial.
  await env.sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = 'signature-clicksign' AND status = 'ACTIVE'", { c: tenant.companyId });
  const canal = await env.conectar(tenant, 'clicksign', 'signature-sandbox');
  const contrato = await env.criarContrato(tenant);
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('legal.clicksign_webhook_secret', 'segredo-legado-clicksign', tenant, tenant.userId, t));
  try {
    await env.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
    const envelope = await env.envelopeDe(tenant, contrato.version.id);
    const sigs = await env.assinaturas(tenant, contrato.version.id);
    const postar = (corpo) => {
      const bruto = Buffer.from(JSON.stringify(corpo));
      return env.postar('/v1/legal/webhooks/clicksign', bruto, { 'content-hmac': `sha256=${crypto.createHmac('sha256', 'segredo-legado-clicksign').update(bruto).digest('hex')}` });
    };
    const sem = await env.postar('/v1/legal/webhooks/clicksign', Buffer.from(JSON.stringify({ event: { name: 'sign', data: { signer: { key: sigs[0].external_signature_id } } } })), { 'content-hmac': `sha256=${'0'.repeat(64)}` });
    assert.equal(sem.status, 401, `a rota antiga continua exigindo o HMAC (${JSON.stringify(sem.json).slice(0, 200)})`);
    for (const s of sigs) {
      const r = await postar({ event: { name: 'sign', occurred_at: iso(), data: { signer: { key: s.external_signature_id, email: s.signer_email, name: 'X' } } } });
      assert.equal(r.status, 200);
      assert.equal(r.json.data.processed, true);
    }
    assert.equal(await env.statusContrato(tenant, contrato.contract.id), 'SIGNING', 'falta o fechamento do envelope');
    const fecha = await postar({ event: { name: 'auto_close', occurred_at: iso(), data: { envelope: { id: envelope.external_envelope_id } } } });
    assert.equal(fecha.status, 200);
    assert.equal(await env.statusContrato(tenant, contrato.contract.id), 'SIGNED', 'o mesmo caminho do framework: signatário previsto, evidência e fechamento');
    const [e] = await env.sql(tenant, 'SELECT status, signed_sha256 FROM legal.signature_envelopes WHERE id = :id', { id: envelope.id });
    assert.deepEqual([e.status, /^[0-9a-f]{64}$/.test(e.signed_sha256)], ['SIGNED', true]);
  } finally {
    await env.sql(tenant, "DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'legal.clicksign_webhook_secret'", { c: tenant.companyId });
  }
  assert.ok(canal);
});

test('assinatura_versao_do_documento_confere_com_a_aprovada', async () => {
  const canal = await env.conectar(tenant, 'sandbox', 'signature-sandbox');
  const contrato = await env.criarContrato(tenant);
  const v1 = contrato.version;
  assert.match(v1.contentHash, /^[0-9a-f]{64}$/);
  const [antes] = await env.sql(tenant, 'SELECT count(*)::int AS n FROM integration.dispatches WHERE aggregate_id = :v', { v: v1.id });
  // Uma versão mais nova passa a ser a vigente: a antiga não vai mais para assinatura.
  await env.sql(tenant, `INSERT INTO legal.contract_versions (id, group_id, company_id, contract_id, version_number, content_hash, content, effective_from, created_at, updated_at)
    SELECT gen_random_uuid(), group_id, company_id, contract_id, version_number + 1, repeat('b', 64), 'v2', effective_from, now(), now() FROM legal.contract_versions WHERE id = :v`, { v: v1.id });
  await assert.rejects(env.pedirAssinatura(tenant, v1, [contrato.tenantPerson]), (e) => e.code === 'LEGAL_SIGNATURE_VERSION_SUPERSEDED', 'versão que não é a vigente é recusada');
  const [depois] = await env.sql(tenant, 'SELECT count(*)::int AS n FROM integration.dispatches WHERE aggregate_id = :v', { v: v1.id });
  assert.equal(depois.n, antes.n, 'nada foi enviado ao fornecedor');
  const outro = await env.criarContrato(tenant);
  await env.pedirAssinatura(tenant, outro.version, [outro.tenantPerson, outro.landlord]);
  const envelope = await env.envelopeDe(tenant, outro.version.id);
  assert.equal(envelope.document_sha256, outro.version.contentHash, 'o envelope leva o hash da versão aprovada');
  const sigs = await env.assinaturas(tenant, outro.version.id);
  await env.enviar(canal, env.eventoA('signer.signed', {
    envelopeId: envelope.external_envelope_id, signer: { id: sigs[0].external_signature_id, email: sigs[0].signer_email }, signedAt: iso(), evidence: env.EVIDENCIA, documentSha256: 'b'.repeat(64),
  }));
  await env.rodar(tenant);
  assert.equal((await env.envelopeDe(tenant, outro.version.id)).status, 'HASH_MISMATCH', 'evento com o hash de outra versão é recusado e registrado');
  assert.equal(contractVersionsService != null, true);
});

/** Cenário completo (pedido, duas assinaturas, conclusão) num formato de webhook; devolve o resultado interno normalizado. */
async function cenario(formato) {
  const setting = formato === 'A' ? 'sandbox' : 'sandbox-alt';
  const canal = await env.conectar(tenant, setting, formato === 'A' ? 'signature-sandbox' : 'signature-alt-sandbox');
  const contrato = await env.criarContrato(tenant);
  await env.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
  const envelope = await env.envelopeDe(tenant, contrato.version.id);
  const sigs = await env.assinaturas(tenant, contrato.version.id);
  const enviar = formato === 'A' ? (o) => env.enviar(canal, o) : (o) => env.enviarB(canal, o);
  const monta = formato === 'A' ? env.eventoA : env.eventoB;
  const tipos = formato === 'A' ? ['signer.signed', 'envelope.completed'] : ['party.signed', 'doc.completed'];
  for (const s of sigs) {
    await enviar(monta(tipos[0], { envelopeId: envelope.external_envelope_id, signer: { id: s.external_signature_id, email: s.signer_email, name: 'X' }, signedAt: iso(), evidence: env.EVIDENCIA }));
    await env.rodar(tenant);
  }
  await enviar(monta(tipos[1], { envelopeId: envelope.external_envelope_id, documentSha256: envelope.document_sha256 }));
  await env.rodar(tenant);
  const e = await env.envelopeDe(tenant, contrato.version.id);
  const final = await env.assinaturas(tenant, contrato.version.id);
  return {
    contrato: await env.statusContrato(tenant, contrato.contract.id), envelope: e.status, hashEnviadoConfirmado: e.original_confirmed_sha256 === envelope.document_sha256, arquivoAssinado: /^[0-9a-f]{64}$/.test(e.signed_sha256),
    assinaturas: final.map((s) => ({ status: s.status, completa: s.evidence_complete, metodo: s.evidence_json.authMethod, ip: s.evidence_json.ip, userAgent: s.evidence_json.userAgent, hash: s.evidence_json.documentSha256 === envelope.document_sha256, fornecedorSimulado: s.evidence_json.simulated || false })),
  };
}

test('assinatura_troca_de_provider_preserva_envelope_signer_evidence', async () => {
  const a = await cenario('A');
  const b = await cenario('B');
  assert.deepEqual(a.assinaturas.length, 2);
  assert.equal(a.contrato, 'SIGNED');
  assert.deepEqual(b, a, 'o mesmo webhook validado, a mesma versão e hash, os mesmos signatários e a mesma evidência: o mesmo resultado interno nos dois formatos');
  const [{ n }] = await env.sql(tenant, "SELECT count(DISTINCT provider_code)::int AS n FROM legal.signature_envelopes WHERE provider_code IN ('signature-sandbox', 'signature-alt-sandbox') AND company_id = :c", { c: tenant.companyId });
  assert.equal(n, 2, 'cada cenário usou um fornecedor diferente (o par connection + id fica no envelope)');
});
