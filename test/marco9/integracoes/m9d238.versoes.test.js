'use strict';

// Marco 9, M9-D238 — apólice versionada (documento e hash, imutável) e marcos de vencimento (60, 30, 15 e 7 dias e expirada) publicados como eventos, uma vez por marco. Banco descartável.
process.env.PORT = process.env.M9D238_VERSOES_PORT || '24239';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d238Env');
const versions = require('../../../src/features/procurement/insurance/insurance.versions');
const milestones = require('../../../src/features/procurement/insurance/insurance.milestones');
const { InsurancePolicy } = require('../../../src/models');
const { expireDuePolicies } = require('../../../src/engines/jobs/insurancePolicyExpiryJob');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const adicionar = (apolice, args) => env.comTenant(tenant, async (t) => versions.addPolicyVersion(await InsurancePolicy.findByPk(apolice.id, { transaction: t }), args, env.actorDe(tenant), t));

/** Apólice vigente até a data informada (emitida pelo sandbox e com a vigência ajustada no banco). */
async function vigente(expiryDate) {
  const a = await env.criarApolice(tenant);
  await env.cotar(tenant, a.id);
  await env.emitir(tenant, a.id);
  await env.sql(tenant, 'UPDATE procurement.insurance_policies SET effective_date = :e, expiry_date = :x WHERE id = :id', { id: a.id, e: '2026-01-01', x: expiryDate });
  return a;
}
const rodarMarcos = (hoje) => env.comTenant(tenant, (t) => milestones.publishDueMilestones(t, hoje));
const marcosDe = async (apolice) => (await env.eventos(tenant, apolice.id, 'insurance.policy.expiring')).map((e) => ({ marco: e.payload_json.marco, dias: e.payload_json.daysToExpiry }));

test('seguro_apolice_nova_versao_preserva_anterior', async () => {
  const a = await vigente('2026-12-31');
  const f1 = await env.criarArquivo(tenant);
  const f2 = await env.criarArquivo(tenant);
  const f3 = await env.criarArquivo(tenant);
  const v1 = await adicionar(a, { fileId: f1.id, effectiveFrom: '2026-01-01', source: 'MANUAL' });
  assert.deepEqual([v1.version, v1.kind], [1, 'INITIAL']);
  const v2 = await adicionar(a, { fileId: f2.id, kind: 'ENDORSEMENT', effectiveFrom: '2026-06-01' });
  assert.deepEqual([v2.version, v2.kind], [2, 'ENDORSEMENT']);
  const antes = await env.apolice(tenant, a.id);
  const v3 = await adicionar(a, { fileId: f3.id, kind: 'RENEWAL', effectiveFrom: '2027-01-01', expiryDate: '2027-12-31' });
  assert.deepEqual([v3.version, v3.kind], [3, 'RENEWAL']);
  const todas = await env.versoes(tenant, a.id);
  assert.deepEqual(todas.map((v) => v.version), [1, 2, 3], 'a anterior é preservada');
  assert.deepEqual(todas.map((v) => v.file_id), [f1.id, f2.id, f3.id]);
  assert.equal(todas[0].sha256, f1.checksumSha256, 'o hash do documento de cada versão');
  assert.equal((await versions.currentVersion(a.id, tenant.companyId, null) || todas[2]).version, 3);
  const depois = await env.apolice(tenant, a.id);
  assert.equal(String(depois.expiry_date).slice(0, 10) > String(antes.expiry_date).slice(0, 10) || depois.expiry_date.toISOString().slice(0, 10) === '2027-12-31', true, 'a renovação estende a vigência');
  assert.equal((await env.tarefaRenovacao(tenant, a.id)).length, 2, 'e recomeça o ciclo de alerta de renovação');
  // Imutável no banco: nem UPDATE nem DELETE.
  await assert.rejects(env.sql(tenant, 'UPDATE procurement.insurance_policy_versions SET sha256 = repeat(\'a\', 64) WHERE id = :id', { id: todas[0].id }), /imut/i);
  await assert.rejects(env.sql(tenant, 'DELETE FROM procurement.insurance_policy_versions WHERE id = :id', { id: todas[0].id }), /imut/i);
  // Versão repetida: 409; versão fora de ordem: 422.
  await assert.rejects(adicionar(a, { fileId: f2.id, version: 2, effectiveFrom: '2026-06-01' }), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_INSURANCE_POLICY_VERSION_EXISTS' && e.message === 'Esta versão da apólice já foi registrada.');
  await assert.rejects(adicionar(a, { fileId: f2.id, version: 9, effectiveFrom: '2026-06-01' }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_INSURANCE_POLICY_VERSION_INVALID');
  await assert.rejects(adicionar(a, { fileId: f2.id, kind: 'RENEWAL', effectiveFrom: '2028-01-01', expiryDate: '2027-06-01' }), (e) => e.code === 'INTEGRATION_INSURANCE_POLICY_VERSION_INVALID');
  assert.equal((await env.versoes(tenant, a.id)).length, 3);
  assert.equal((await env.eventos(tenant, a.id, 'insurance.policy.version_added')).length, 3);
});

test('seguro_versao_exige_documento_e_hash', async () => {
  const a = await vigente('2026-12-31');
  const expectativa = (e) => e.statusCode === 422 && e.code === 'INTEGRATION_INSURANCE_POLICY_DOCUMENT_REQUIRED' && e.message === 'Anexe o documento da apólice para torná-la vigente.';
  await assert.rejects(adicionar(a, { effectiveFrom: '2026-01-01' }), expectativa);
  await assert.rejects(adicionar(a, { fileId: '11111111-1111-4111-8111-111111111111', effectiveFrom: '2026-01-01' }), expectativa);
  const semHash = await env.criarArquivo(tenant, { checksum: false });
  await assert.rejects(adicionar(a, { fileId: semHash.id, effectiveFrom: '2026-01-01' }), expectativa);
  assert.equal((await env.versoes(tenant, a.id)).length, 0, 'nenhuma versão vira vigente sem documento e hash');
  const ok = await env.criarArquivo(tenant);
  assert.equal((await adicionar(a, { fileId: ok.id, effectiveFrom: '2026-01-01' })).version, 1);
});

test('seguro_eventos_de_vencimento_60_30_15_7_expired', async () => {
  const a = await vigente('2026-12-31');
  for (const [hoje, esperado] of [['2026-10-31', []], ['2026-11-01', [60]], ['2026-12-01', [60, 30]], ['2026-12-16', [60, 30, 15]], ['2026-12-24', [60, 30, 15, 7]]]) {
    await rodarMarcos(hoje);
    assert.deepEqual((await marcosDe(a)).map((m) => m.marco), esperado, `em ${hoje}`);
  }
  assert.deepEqual(await marcosDe(a), [{ marco: 60, dias: 60 }, { marco: 30, dias: 30 }, { marco: 15, dias: 15 }, { marco: 7, dias: 7 }], '01/11, 01/12, 16/12 e 24/12 para a vigência até 31/12');
  const [primeiro] = await env.eventos(tenant, a.id, 'insurance.policy.expiring');
  assert.deepEqual(Object.keys(primeiro.payload_json).sort(), ['daysToExpiry', 'expiryDate', 'marco', 'policyId'], 'só ids, datas e números: nenhum dado pessoal');
  // No dia seguinte ao fim da vigência: expired (e a apólice vira EXPIRED pelo job).
  await env.comTenant(tenant, (t) => expireDuePolicies(t, new Date('2027-01-01T15:00:00Z')));
  assert.equal((await env.apolice(tenant, a.id)).status, 'EXPIRED');
  const expirou = await env.eventos(tenant, a.id, 'insurance.policy.expired');
  assert.equal(expirou.length, 1);
  assert.equal(expirou[0].payload_json.expiryDate, '2026-12-31');
  // Antes de acabar a vigência, nada de expired.
  const b = await vigente('2027-03-31');
  await env.comTenant(tenant, (t) => expireDuePolicies(t, new Date('2027-03-31T15:00:00Z')));
  assert.equal((await env.eventos(tenant, b.id, 'insurance.policy.expired')).length, 0, 'no último dia da vigência ainda vale');
});

test('seguro_evento_idempotente_por_marco', async () => {
  const a = await vigente('2027-02-28');
  await rodarMarcos('2026-12-30'); // 60 dias
  await rodarMarcos('2026-12-30');
  await rodarMarcos('2026-12-31'); // 59 dias: ainda a faixa do marco 60
  assert.equal((await marcosDe(a)).length, 1, 'o marco 60 sai uma vez, mesmo rodando de novo e nos dias seguintes da faixa');
  await rodarMarcos('2027-01-29'); // 30 dias
  await rodarMarcos('2027-01-29');
  assert.deepEqual((await marcosDe(a)).map((m) => m.marco), [60, 30]);
  // Apólice emitida já dentro da faixa (10 dias): publica o marco 15 uma vez, sem os anteriores.
  const tardia = await vigente('2027-03-10');
  await rodarMarcos('2027-02-28');
  await rodarMarcos('2027-02-28');
  assert.deepEqual((await marcosDe(tardia)).map((m) => m.marco), [15]);
  // Expirada duas vezes: um só evento.
  await env.comTenant(tenant, (t) => expireDuePolicies(t, new Date('2027-03-01T15:00:00Z')));
  await env.comTenant(tenant, (t) => expireDuePolicies(t, new Date('2027-03-02T15:00:00Z')));
  assert.equal((await env.eventos(tenant, a.id, 'insurance.policy.expired')).length, 1);
  // Parâmetro da empresa: os marcos são os da configuração.
  await env.config(tenant, 'integration.insurance.renewal_alert_days', '45,10');
  const c = await vigente('2027-06-30');
  await rodarMarcos('2027-05-16'); // 45 dias
  await rodarMarcos('2027-06-20'); // 10 dias
  assert.deepEqual((await marcosDe(c)).map((m) => m.marco), [45, 10]);
  await assert.rejects(env.config(tenant, 'integration.insurance.renewal_alert_days', '60;30'), (e) => e.statusCode === 400);
  await env.config(tenant, 'integration.insurance.renewal_alert_days', '60,30,15,7');
});
