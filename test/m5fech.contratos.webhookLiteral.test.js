'use strict';

// Matriz de fechamento do Marco 5 (Contratos) — rota literal do Guia §14 "POST /webhooks/signature/:provider" sobre o
// mesmo framework da rota única (assinatura no corpo bruto, caixa de entrada idempotente). Mesmo apoio dos testes
// M9-D236 (contrato em SIGNING, canal do fornecedor de laboratório com segredo no cofre). Banco descartável.
process.env.PORT = process.env.M5FECH_CT_PORT || require('./marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('./marco9/_helpers/m9d236Env');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const literal = (canal, obj, headers) => {
  const corpo = Buffer.from(JSON.stringify(obj));
  return env.postar(`/v1/webhooks/signature/sandbox?channel=${encodeURIComponent(canal.canal)}`, corpo, headers || env.assinar(canal.segredo, corpo));
};

test('Guia §14: POST /webhooks/signature/:provider valida a assinatura do corpo e é idempotente (mesmo id externo = uma atualização)', async () => {
  const canal = await env.conectar(tenant, 'sandbox', 'signature-sandbox');
  const contrato = await env.criarContrato(tenant);
  await env.pedirAssinatura(tenant, contrato.version, [contrato.tenantPerson, contrato.landlord]);
  const envelope = await env.envelopeDe(tenant, contrato.version.id);
  const [sig] = await env.assinaturas(tenant, contrato.version.id);
  const ev = env.eventoA('signer.signed', { envelopeId: envelope.external_envelope_id, signer: { id: sig.external_signature_id, email: sig.signer_email, name: 'Signatário' }, signedAt: new Date().toISOString(), evidence: env.EVIDENCIA });

  const falso = await literal(canal, ev, { 'x-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
  assert.equal(falso.status, 401);
  assert.equal(falso.json.error.code, 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID');

  const r1 = await literal(canal, ev);
  assert.equal(r1.json.status, 'accepted');
  const r2 = await literal(canal, ev);
  assert.equal(r2.json.status, 'duplicate', 'o mesmo evento (mesmo id externo) não entra duas vezes');
  await env.rodar(tenant);
  const [{ n }] = await env.sql(tenant, 'SELECT count(*)::int AS n FROM integration.webhook_inbox WHERE company_id = :c AND external_event_id = :e', { c: tenant.companyId, e: ev.id });
  assert.equal(n, 1, 'uma linha na caixa de entrada');
  const sigs = await env.assinaturas(tenant, contrato.version.id);
  assert.equal(sigs.filter((s) => s.status === 'SIGNED').length, 1, 'uma única atualização');
});
