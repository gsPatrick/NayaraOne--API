'use strict';

// Livro do Marco 3 §18 ("Exportar base de clientes — Permissão, MFA, volume limit, audit"), §19 CRM-TS-013 ("Mass export — Sem permissão —
// Negado") e M3-21 ("Exportação sensível limitada e auditada"), pelo CAMINHO VIVO POST /exports (o antigo GET /crm/opportunities/export
// responde 410). Login real no seed de dois tenants (empresa A); MFA recente gravado no banco descartável (nunca pela rota de MFA).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/m3cbCarteiraEnv');

let env; let company;
const as = (who) => env.tokens[`A:${who}`];
const corpo = (over = {}) => ({ resourceType: 'crm.opportunities', format: 'CSV', purpose: 'OPERACAO', justification: 'Relatório da reunião semanal de vendas da equipe comercial', ...over });
let seq = 0;
const pedir = (who, over) => env.call('POST', '/exports', as(who), corpo(over), { 'Idempotency-Key': `m3cb-export-${Date.now()}-${(seq += 1)}-abcdefgh` });
const auditoria = async (action, entityId) => (await H.admin('SELECT * FROM audit.audit_log WHERE action = $1 AND entity_id = $2 ORDER BY occurred_at', [action, entityId])).rows;
const job = async (id) => (await H.admin('SELECT * FROM governance.export_jobs WHERE id = $1', [id])).rows[0];

async function pronto(who, id) {
  for (let i = 0; i < 80; i += 1) {
    const r = await env.call('GET', `/exports/${id}`, as(who));
    if (r.body.data && ['READY', 'FAILED'].includes(r.body.data.status)) return r.body.data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`exportação ${id} não ficou pronta`);
}
async function baixar(who, url) {
  const res = await fetch(`http://127.0.0.1:${process.env.M3CB_EXPORT_HTTP_PORT || 34231}${url.startsWith('/api') ? url : `/api/v1${url}`}`, { headers: { Authorization: `Bearer ${as(who)}` } });
  assert.equal(res.status, 200, await res.clone().text());
  return res.text();
}

before(async () => {
  if (!H.DISPOSABLE) return;
  env = await H.subir(Number(process.env.M3CB_EXPORT_HTTP_PORT) || 34231, {
    maker: ['governance:dlp:export', 'crm:opportunities:export'], checker: ['governance:dlp:export'], gestor: ['governance:dlp:export', 'crm:opportunities:export'],
  });
  company = await H.companyA();
  await H.limparSinaisDlp(Object.values(env.ids));
  await H.oportunidadeDe(env, env.ids.maker, 'Exportação A1');
  await H.oportunidadeDe(env, env.ids.maker, 'Exportação A2');
  await H.oportunidadeDe(env, env.ids.checker, 'Exportação B1');
});
after(async () => {
  if (!H.DISPOSABLE || !env) return;
  for (const who of ['maker', 'checker', 'gestor']) await H.semMfa(env.ids[who]);
  await H.admin("UPDATE governance.dlp_policies SET max_rows = 10000 WHERE company_id = $1 AND classification = 'HIGH' AND action = 'EXPORT'", [company.id]);
  await H.encerrar();
});

test('CRM-TS-013 Mass export: sem a permissão crm:opportunities:export (com MFA recente) é negado com GOV_DLP_PERMISSION, pedido BLOCKED e tentativa auditada', { skip: H.SKIP }, async () => {
  await H.mfaRecente(env.ids.checker, company.id);
  const r = await pedir('checker');
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'GOV_DLP_PERMISSION', 'o motivo é a permissão, não o MFA');
  const pedido = await job(r.body.error.details.exportJobId);
  assert.equal(pedido.status, 'BLOCKED');
  assert.equal(pedido.block_reason, 'PERMISSION');
  assert.equal(pedido.classification, 'HIGH');
  const [aud] = await auditoria('governance.dlp.export.blocked', pedido.id);
  assert.ok(aud, 'a tentativa bloqueada fica na auditoria');
  assert.equal(aud.before_json.decision, 'DENY');
});

test('M3-21 MFA: com as permissões e sem MFA recente, 403 MFA_STEP_UP_REQUIRED e nada é gerado', { skip: H.SKIP }, async () => {
  await H.semMfa(env.ids.maker);
  const r = await pedir('maker');
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'MFA_STEP_UP_REQUIRED');
  const pedido = await job(r.body.error.details.exportJobId);
  assert.equal(pedido.block_reason, 'MFA');
  assert.equal(pedido.file_id, null);
});

test('M3-21 volume: acima do teto da classe HIGH (política da empresa) é recusado com 422 GOV_DLP_VOLUME_EXCEEDED, não truncado', { skip: H.SKIP }, async () => {
  await H.mfaRecente(env.ids.gestor, company.id);
  await H.admin("UPDATE governance.dlp_policies SET max_rows = 1 WHERE company_id = $1 AND classification = 'HIGH' AND action = 'EXPORT'", [company.id]);
  try {
    const r = await pedir('gestor');
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'GOV_DLP_VOLUME_EXCEEDED');
    const pedido = await job(r.body.error.details.exportJobId);
    assert.equal(pedido.block_reason, 'VOLUME');
    assert.ok(Number(pedido.estimated_rows) > 1);
  } finally {
    await H.admin("UPDATE governance.dlp_policies SET max_rows = 10000 WHERE company_id = $1 AND classification = 'HIGH' AND action = 'EXPORT'", [company.id]);
  }
});

test('M3-21 aprovado: APPROVED -> READY com MFA; o corretor de escopo próprio exporta só a própria carteira; pedido, geração e download auditados', { skip: H.SKIP }, async () => {
  await H.mfaRecente(env.ids.maker, company.id);
  const r = await pedir('maker');
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'APPROVED');
  const id = r.body.data.exportJobId;
  const pronta = await pronto('maker', id);
  assert.equal(pronta.status, 'READY', JSON.stringify(pronta));
  const csv = await baixar('maker', pronta.downloadUrl);
  const [{ n: deA }] = (await H.admin('SELECT count(*)::int AS n FROM crm.opportunities WHERE company_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL', [company.id, env.ids.maker])).rows;
  assert.equal(Number(pronta.rowCount), deA, 'só as oportunidades da carteira do corretor A');
  assert.ok(csv.includes(env.ids.maker));
  assert.ok(!csv.includes(env.ids.checker), 'nenhuma linha da carteira de B');
  assert.equal((await auditoria('governance.dlp.export', id)).length, 1, 'pedido liberado auditado');
  const [gerado] = await auditoria('dlp.export.generated', id);
  assert.equal(Number(gerado.after_json.rowCount), deA);
  assert.equal((await auditoria('dlp.export.downloaded', id)).length, 1, 'download auditado');

  await H.mfaRecente(env.ids.gestor, company.id);
  const g = await pedir('gestor');
  assert.equal(g.status, 202, JSON.stringify(g.body));
  const doGestor = await pronto('gestor', g.body.data.exportJobId);
  const [{ n: todas }] = (await H.admin('SELECT count(*)::int AS n FROM crm.opportunities WHERE company_id = $1 AND deleted_at IS NULL', [company.id])).rows;
  assert.equal(Number(doGestor.rowCount), todas, 'o gestor (read:all) exporta a empresa inteira');
});

test('M3-21 a rota antiga não exporta: GET /crm/opportunities/export responde 410 com o novo caminho', { skip: H.SKIP }, async () => {
  const r = await env.call('GET', '/crm/opportunities/export', as('gestor'));
  assert.equal(r.status, 410, JSON.stringify(r.body));
});
