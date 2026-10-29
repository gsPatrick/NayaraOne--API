'use strict';

// Marco 9, M9-D236 — assinatura digital sobre o framework: webhook assinado, hash do original, signatário previsto, evidência completa e eventos fora de ordem.
// Envelope e assinaturas pelo serviço do Jurídico (pedido via Dispatch Service), eventos pela rota única de webhooks e worker da caixa de entrada. Banco descartável.
process.env.PORT = process.env.M9D236_FLUXO_PORT || '21236';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d236Env');
const settingsService = require('../../../src/features/settings/settings.service');
const signatureFlow = require('../../../src/features/legal/signature');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const iso = () => new Date().toISOString();

/** Contrato pronto, fornecedor ativo (formato A) e pedido de assinatura feito. */
async function iniciar() {
  const canal = await env.conectar(tenant, 'sandbox', 'signature-sandbox');
  const contrato = await env.criarContrato(tenant);
  await env.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
  const envelope = await env.envelopeDe(tenant, contrato.version.id);
  const sigs = await env.assinaturas(tenant, contrato.version.id);
  return { canal, contrato, envelope, sigs };
}

const signerDe = (s) => ({ id: s.external_signature_id, email: s.signer_email, name: 'Signatário' });
const assina = async (c, sig, extra = {}) => {
  const r = await env.enviar(c.canal, env.eventoA('signer.signed', { envelopeId: c.envelope.external_envelope_id, signer: signerDe(sig), signedAt: iso(), evidence: env.EVIDENCIA, ...extra }));
  await env.rodar(tenant);
  return r;
};
const conclui = async (c, documentSha256) => {
  const r = await env.enviar(c.canal, env.eventoA('envelope.completed', { envelopeId: c.envelope.external_envelope_id, documentSha256 }));
  await env.rodar(tenant);
  return r;
};
const erro = (c, codigo) => env.erros(tenant, c.canal.provider, codigo);

test('assinatura_webhook_hmac_pelo_framework', async () => {
  const c = await iniciar();
  assert.ok(c.envelope.external_envelope_id, 'o envelope tem o id do fornecedor (par connection + id)');
  assert.equal(c.envelope.connection_id, c.canal.conn.id);
  assert.equal(c.sigs.length, 2);
  assert.equal(c.sigs.every((s) => s.external_signature_id && s.envelope_id === c.envelope.id), true, 'cada signatário ligado ao seu id no fornecedor');
  const ev = env.eventoA('signer.signed', { envelopeId: c.envelope.external_envelope_id, signer: signerDe(c.sigs[0]), signedAt: iso(), evidence: env.EVIDENCIA });
  const falso = await env.postar(`/v1/webhooks/${c.canal.provider}/${c.canal.canal}`, Buffer.from(JSON.stringify(ev)), { 'x-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
  assert.equal(falso.status, 401);
  assert.equal(falso.json.error.code, 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID');
  assert.equal(falso.json.error.message, 'Assinatura inválida.');
  assert.equal((await env.assinaturas(tenant, c.contrato.version.id)).every((s) => s.status === 'PENDING'), true, 'webhook inválido não muda nada');
  const ok = await env.enviar(c.canal, ev);
  assert.equal(ok.json.status, 'accepted', 'a assinatura HMAC com o segredo da connection foi conferida pelo framework (corpo bruto)');
  await env.rodar(tenant);
  assert.equal((await env.assinaturas(tenant, c.contrato.version.id)).filter((s) => s.status === 'SIGNED').length, 1);
});

test('assinatura_hash_confere_aceita', async () => {
  const c = await iniciar();
  await assina(c, c.sigs[0]);
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING', 'com uma das duas assinaturas o contrato ainda não está assinado');
  await assina(c, c.sigs[1]);
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING', 'todas assinaram, mas o envelope ainda não foi concluído com o hash do original conferido');
  await conclui(c, c.envelope.document_sha256);
  const e = await env.envelopeDe(tenant, c.contrato.version.id);
  assert.equal(e.status, 'SIGNED');
  assert.match(e.signed_sha256, /^[0-9a-f]{64}$/, 'hash do arquivo assinado registrado');
  assert.notEqual(e.signed_sha256, e.document_sha256, 'o arquivo assinado é outro arquivo, com outro hash');
  assert.equal(e.original_confirmed_sha256, c.envelope.document_sha256, 'o fornecedor confirmou o conteúdo original enviado');
  const [arquivo] = await env.sql(tenant, 'SELECT checksum_sha256 FROM people.files WHERE id = :id', { id: e.signed_document_file_id });
  assert.equal(arquivo.checksum_sha256, e.signed_sha256);
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNED');
  const sigs = await env.assinaturas(tenant, c.contrato.version.id);
  for (const s of sigs) {
    assert.equal(s.evidence_complete, true);
    assert.equal(s.evidence_json.documentSha256, c.envelope.document_sha256);
    assert.equal(s.evidence_json.authMethod, env.EVIDENCIA.authMethod);
    assert.equal(s.evidence_json.ip, env.EVIDENCIA.ip);
    assert.ok(s.evidence_json.signedAtProvider && s.evidence_file_id, 'horário do fornecedor e arquivo de evidência guardado');
  }
  await assert.rejects(env.sql(tenant, "UPDATE legal.signatures SET evidence_json = '{}'::jsonb WHERE id = :id", { id: sigs[0].id }), /imutável/, 'a evidência é imutável');
});

test('assinatura_hash_diverge_bloqueia', async () => {
  const c = await iniciar();
  await assina(c, c.sigs[0]);
  await assina(c, c.sigs[1]);
  await conclui(c, 'cd'.repeat(32));
  const e = await env.envelopeDe(tenant, c.contrato.version.id);
  assert.equal(e.status, 'HASH_MISMATCH');
  assert.equal(e.original_confirmed_sha256, 'cd'.repeat(32));
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING', 'o contrato NÃO vai a SIGNED');
  const [incidente] = await erro(c, 'INTEGRATION_LEGAL_SIGNATURE_HASH_MISMATCH');
  assert.equal(incidente.severity, 'CRITICAL', 'incidente CRITICAL');
  assert.equal(incidente.message, 'O documento assinado não corresponde à versão enviada.');
  const [tardio] = await env.sql(tenant, "SELECT status FROM legal.signatures WHERE contract_version_id = :v AND status = 'SIGNED' LIMIT 1", { v: c.contrato.version.id });
  assert.ok(tardio, 'as assinaturas individuais ficam registradas, mas o conjunto não conclui');
  const outro = await iniciar();
  await assina(outro, outro.sigs[0], { documentSha256: 'ef'.repeat(32) });
  assert.equal((await env.envelopeDe(tenant, outro.contrato.version.id)).status, 'HASH_MISMATCH', 'o hash divergente também é pego no evento de assinatura de um signatário');
});

test('assinatura_signatario_nao_previsto_recusado', async () => {
  const c = await iniciar();
  const r = await env.enviar(c.canal, env.eventoA('signer.signed', { envelopeId: c.envelope.external_envelope_id, signer: { id: 'sbx-sig-estranho', email: 'estranho@qa-m9.test', name: 'Estranho' }, signedAt: iso(), evidence: env.EVIDENCIA }));
  assert.equal(r.status, 200);
  await env.rodar(tenant);
  const [linha] = await env.inbox(tenant, c.canal.provider, r.json.eventId);
  assert.deepEqual([linha.status, linha.applied], ['PROCESSED', false], 'o evento fica no histórico e não é aplicado');
  assert.equal((await env.assinaturas(tenant, c.contrato.version.id)).every((s) => s.status === 'PENDING'), true);
  const [recusa] = await erro(c, 'INTEGRATION_LEGAL_SIGNER_NOT_EXPECTED');
  assert.equal(recusa.message, 'Assinatura de pessoa não prevista no envelope.');
  const idCerto = await env.enviar(c.canal, env.eventoA('signer.signed', { envelopeId: c.envelope.external_envelope_id, signer: { id: c.sigs[0].external_signature_id, email: 'outro-email@qa-m9.test', name: 'X' }, signedAt: iso(), evidence: env.EVIDENCIA }));
  await env.rodar(tenant);
  assert.equal((await env.inbox(tenant, c.canal.provider, idCerto.json.eventId))[0].applied, false, 'id certo com e-mail que não é o previsto também é recusado');
});

test('assinatura_evidencia_completa_exigida', async () => {
  const c = await iniciar();
  const semMetodo = { ip: env.EVIDENCIA.ip, userAgent: env.EVIDENCIA.userAgent };
  await assina(c, c.sigs[0], { evidence: semMetodo });
  await assina(c, c.sigs[1], { evidence: semMetodo });
  await conclui(c, c.envelope.document_sha256);
  const sigs = await env.assinaturas(tenant, c.contrato.version.id);
  assert.equal(sigs.every((s) => s.status === 'SIGNED' && s.evidence_complete === false), true, 'assinadas, mas sem o método de autenticação a evidência é incompleta');
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING', 'SIGNED só com TODAS as evidências completas');
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('legal.assinatura.exigir_evidencia_completa', false, tenant, tenant.userId, t));
  try {
    assert.equal(await env.comTenant(tenant, (t) => signatureFlow.tryCompleteContract(c.contrato.version.id, t)), true, 'o parâmetro legal.assinatura.exigir_evidencia_completa libera o portão');
    assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNED');
  } finally {
    await env.sql(tenant, "DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'legal.assinatura.exigir_evidencia_completa'", { c: tenant.companyId });
  }
  const d = await iniciar();
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('legal.assinatura.exigir_ip_user_agent', true, tenant, tenant.userId, t));
  try {
    await assina(d, d.sigs[0], { evidence: { authMethod: 'EMAIL_TOKEN' } });
    assert.equal((await env.assinaturas(tenant, d.contrato.version.id))[0].evidence_complete, false, 'com legal.assinatura.exigir_ip_user_agent, sem IP e user-agent a evidência não é completa');
  } finally {
    await env.sql(tenant, "DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'legal.assinatura.exigir_ip_user_agent'", { c: tenant.companyId });
  }
});

test('assinatura_evento_fora_de_ordem_nao_regride', async () => {
  const c = await iniciar();
  await assina(c, c.sigs[0]);
  await assina(c, c.sigs[1]);
  await conclui(c, c.envelope.document_sha256);
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNED');
  const cancelado = await env.enviar(c.canal, env.eventoA('envelope.cancelled', { envelopeId: c.envelope.external_envelope_id }));
  await env.rodar(tenant);
  assert.equal((await env.inbox(tenant, c.canal.provider, cancelado.json.eventId))[0].applied, false, 'cancelamento depois de assinado: posição menor, guardado sem aplicar');
  assert.equal((await env.envelopeDe(tenant, c.contrato.version.id)).status, 'SIGNED', 'cancelado depois de assinado não reabre');
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNED');
  const d = await iniciar();
  await env.enviar(d.canal, env.eventoA('envelope.cancelled', { envelopeId: d.envelope.external_envelope_id }));
  await env.rodar(tenant);
  assert.equal((await env.envelopeDe(tenant, d.contrato.version.id)).status, 'CANCELLED');
  await assina(d, d.sigs[0]);
  const depois = await env.assinaturas(tenant, d.contrato.version.id);
  assert.equal(depois.every((s) => s.status === 'CANCELLED'), true, 'assinatura que chega depois do cancelamento não reabre o envelope');
  assert.equal(await env.statusContrato(tenant, d.contrato.contract.id), 'SIGNING');
});
