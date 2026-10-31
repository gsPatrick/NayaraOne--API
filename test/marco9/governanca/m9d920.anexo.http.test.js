'use strict';

// M9-D920 §3.2 — classificação do anexo: padrão HIGH no upload, só quem tem governance:classification:manage define ou altera, a leitura em tela de HIGH e o guard em RESTRICTED no
// GET /files/:id/content. API real em banco descartável.
// porta aleatória: portas fixas colidem com a API de outro teste que esteja de pé ao mesmo tempo
process.env.PORT = process.env.M9D920_ANEXO_TEST_PORT || String(30000 + Math.floor(Math.random() * 20000));

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d920Env');
const { MAP, REVERSE } = require('../../../migrations/20260101000879-people-files-classification-required-high');
const classification = require('../../../src/features/core-governance/data-quality/classification.service');
const { withTenantTransaction } = require('../../testHelpers');

let http; let A; let restore;
const MANAGE = 'governance:classification:manage';
const VIEW_RESTRICTED = 'governance:dlp:view-restricted';
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);

before(async () => {
  if (!env.DISPOSABLE) return;
  // o token leva as permissões do momento do login: a do gestor entra ANTES de subir a API; o maker fica sem ela
  restore = await env.withRolePermissions({ 'CI GESTOR': { [MANAGE]: true, [VIEW_RESTRICTED]: true }, 'CI MAKER': { [MANAGE]: false, [VIEW_RESTRICTED]: false } });
  http = await env.start(process.env.PORT);
  A = http.tenants.A;
});
afterEach(async () => { if (env.DISPOSABLE) await env.reset(); });
after(async () => { if (env.DISPOSABLE) { await env.reset(); await restore(); } await stopHttp({}); });

test('m9d920 anexo sem classe nasce HIGH', { skip: skip() }, async () => {
  const bare = await env.upload(http, 'gestorA', {});
  assert.equal(bare.status, 201);
  assert.equal((await env.fileRow(bare.id)).classification, 'HIGH', 'avulso (sem categoria) é HIGH');
  const generic = await env.upload(http, 'gestorA', { category: 'generic' });
  assert.equal((await env.fileRow(generic.id)).classification, 'HIGH');
  const unknown = await env.upload(http, 'gestorA', { category: 'categoria-que-nao-existe' });
  assert.equal((await env.fileRow(unknown.id)).classification, 'HIGH');
  const column = (await env.adminQuery("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'people' AND table_name = 'files' AND column_name = 'classification'")).rows[0];
  assert.deepEqual([column.column_default, column.is_nullable], ["'HIGH'::character varying", 'NO'], 'a classe é obrigatória e o padrão do banco é HIGH');
});

test('m9d920 anexo ligado a uma entidade nasce com a maior classe das colunas dela (parâmetro por categoria)', { skip: skip() }, async () => {
  const doc = await env.upload(http, 'gestorA', { category: 'people-documents' });
  const expected = await withTenantTransaction(A, (tx) => classification.classOfResource({ groupId: A.groupId, companyId: A.companyId }, { type: 'people.person_documents' }, tx));
  assert.equal((await env.fileRow(doc.id)).classification, expected, 'a classe sai do registro de classificação da tabela people.person_documents');
  await env.setSetting(A, 'governanca.dlp.anexos.categoria_entidade', 'people-documents: people.persons');
  try {
    const persons = await withTenantTransaction(A, (tx) => classification.classOfResource({ groupId: A.groupId, companyId: A.companyId }, { type: 'people.persons' }, tx));
    const other = await env.upload(http, 'gestorA', { category: 'people-documents' });
    assert.equal((await env.fileRow(other.id)).classification, persons, 'o administrador muda a tabela da categoria pelo parâmetro');
    const contract = await env.upload(http, 'gestorA', { category: 'contracts' });
    assert.equal((await env.fileRow(contract.id)).classification, 'HIGH', 'categoria que saiu do mapa vira avulsa');
  } finally { await env.clearSetting(A, 'governanca.dlp.anexos.categoria_entidade'); }
});

test('m9d920 classificação explícita no upload só vale com governance:classification:manage', { skip: skip() }, async () => {
  const before = (await env.adminQuery("SELECT count(*)::int AS n FROM people.files WHERE classification = 'LOW'")).rows[0].n;
  const denied = await env.upload(http, 'makerA', { classification: 'LOW' });
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'GOV_FILE_CLASSIFICATION_FORBIDDEN']);
  assert.equal((await env.adminQuery("SELECT count(*)::int AS n FROM people.files WHERE classification = 'LOW'")).rows[0].n, before, 'nada foi gravado');
  const bad = await env.upload(http, 'gestorA', { classification: 'SECRETO' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'GOV_FILE_CLASSIFICATION_INVALID']);
  const ok = await env.upload(http, 'gestorA', { classification: 'MEDIUM' });
  assert.equal(ok.status, 201);
  assert.equal((await env.fileRow(ok.id)).classification, 'MEDIUM');
  const legacy = await env.upload(http, 'gestorA', { classification: 'PUBLIC' });
  assert.equal((await env.fileRow(legacy.id)).classification, 'LOW', 'o vocabulário antigo é convertido');
});

test('m9d920 PUT /files/:id/classification: só com a permissão, com auditoria antes e depois e sem gravar quando igual', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA');
  const denied = await http.call('makerA', 'PUT', `/files/${file.id}/classification`, { classification: 'LOW' });
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'PERMISSION_DENIED']);
  {
    const bad = await http.call('gestorA', 'PUT', `/files/${file.id}/classification`, { classification: 'x' });
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'GOV_FILE_CLASSIFICATION_INVALID']);
    const done = await http.call('gestorA', 'PUT', `/files/${file.id}/classification`, { classification: 'RESTRICTED' });
    assert.deepEqual([done.status, done.body.data.classification, done.body.data.changed], [200, 'RESTRICTED', true]);
    assert.equal((await env.fileRow(file.id)).classification, 'RESTRICTED');
    const same = await http.call('gestorA', 'PUT', `/files/${file.id}/classification`, { classification: 'RESTRICTED' });
    assert.equal(same.body.data.changed, false);
    const audits = await env.adminQuery("SELECT before_json, after_json FROM audit.audit_log WHERE action = 'files.classification' AND entity_id = $1", [file.id]);
    assert.equal(audits.rows.length, 1, 'valor igual não audita');
    assert.deepEqual([audits.rows[0].before_json.classification, audits.rows[0].after_json.classification], ['HIGH', 'RESTRICTED']);
    const missing = await http.call('gestorA', 'PUT', '/files/00000000-0000-4000-8000-000000000000/classification', { classification: 'LOW' });
    assert.equal(missing.status, 404);
    const foreign = await http.call('gestorB', 'PUT', `/files/${file.id}/classification`, { classification: 'LOW' });
    assert.ok([403, 404].includes(foreign.status), 'outra empresa não altera');
  }
});

test('m9d920 migração: o vocabulário antigo converte para a escala do livro e volta', () => {
  const sql = (value) => `SELECT ${MAP.replace(/classification/g, `'${value}'`)} AS v`;
  const run = async (value) => (await env.adminQuery(sql(value))).rows[0].v;
  return Promise.all([['PUBLIC', 'LOW'], ['INTERNAL', 'MEDIUM'], ['CONFIDENTIAL', 'HIGH'], ['RESTRICTED', 'RESTRICTED'], ['qualquer', 'HIGH']].map(async ([old, wanted]) => assert.equal(await run(old), wanted)))
    .then(async () => {
      for (const [scale, legacy] of [['LOW', 'PUBLIC'], ['MEDIUM', 'INTERNAL'], ['HIGH', 'CONFIDENTIAL'], ['RESTRICTED', 'RESTRICTED']]) {
        assert.equal((await env.adminQuery(`SELECT ${REVERSE.replace(/classification/g, `'${scale}'`)} AS v`)).rows[0].v, legacy);
      }
    });
});

test('m9d920 leitura em tela: HIGH abre direto, RESTRICTED passa pelo guard (MFA e justificativa) e o pedido fica registrado', { skip: skip() }, async () => {
  const high = await env.uploadPdf(http, 'gestorA', { classification: 'HIGH' });
  const view = await env.raw(http, 'gestorA', `/files/${high.id}/content`);
  assert.equal(view.status, 200, 'HIGH em tela é leitura (VIEW), sem justificativa');
  assert.ok(Buffer.from(await view.arrayBuffer()).equals(high.buffer));
  assert.equal((await env.jobsOf('DOWNLOAD')).length, 0);
  const forced = await env.raw(http, 'gestorA', `/files/${high.id}/content?download=1`);
  assert.equal(forced.status, 422, 'download=1 de HIGH exige finalidade e justificativa');
  assert.equal((await forced.json()).error.code, 'GOV_DLP_PURPOSE_REQUIRED');

  const restricted = await env.uploadPdf(http, 'gestorA', { classification: 'RESTRICTED' });
  await env.revokeMfa(A.userId);
  const noMfa = await env.raw(http, 'gestorA', `/files/${restricted.id}/content?${env.query()}`);
  assert.equal(noMfa.status, 403);
  const body = await noMfa.json();
  assert.deepEqual([body.error.code, body.error.message], ['MFA_STEP_UP_REQUIRED', 'Confirme o código de verificação para continuar.']);
  const blocked = (await env.jobsOf('DOWNLOAD')).find((j) => j.id === body.error.details.exportJobId);
  assert.deepEqual([blocked.status, blocked.block_reason, blocked.classification], ['BLOCKED', 'MFA', 'RESTRICTED']);
  await env.grantMfa(A);
  await env.clearSignals(); // duas recusas seguidas de RESTRICTED já disparam a suspensão da M9-D824; o caminho feliz abaixo parte de um usuário sem suspensão
  const noWhy = await env.raw(http, 'gestorA', `/files/${restricted.id}/content`);
  assert.deepEqual([noWhy.status, (await noWhy.json()).error.code], [422, 'GOV_DLP_PURPOSE_REQUIRED']);
  await env.clearSignals();
  const ok = await env.raw(http, 'gestorA', `/files/${restricted.id}/content?${env.query()}`);
  assert.equal(ok.status, 200, ok.status === 200 ? '' : JSON.stringify(await ok.json()));
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(restricted.buffer));
  const jobs = await env.jobsOf('DOWNLOAD');
  assert.ok(jobs.some((j) => j.status === 'READY' && j.classification === 'RESTRICTED'), 'o download aprovado fica registrado');
  assert.ok((await env.adminQuery("SELECT 1 FROM audit.audit_log WHERE action = 'files.downloaded' AND entity_id = $1", [restricted.id])).rowCount === 1);
});

test('m9d920 anexo RESTRICTED só é visível a quem tem a permissão dedicada (generalizado pela classificação do arquivo)', { skip: skip() }, async () => {
  const mine = await env.uploadPdf(http, 'makerA', { classification: 'RESTRICTED' });
  const meta = await http.call('makerA', 'GET', `/files/${mine.id}`);
  assert.deepEqual([meta.status, meta.body.error.code], [403, 'FILE_RESTRICTED_DOCUMENT'], 'nem o próprio autor, sem a permissão dedicada, vê um RESTRICTED');
  const content = await env.raw(http, 'makerA', `/files/${mine.id}/content?${env.query()}`);
  assert.equal(content.status, 403);
  assert.equal((await content.json()).error.code, 'FILE_RESTRICTED_DOCUMENT');
  const download = await env.raw(http, 'makerA', `/files/${mine.id}/download?${env.query()}`);
  assert.equal(download.status, 403);
  const batch = await http.call('makerA', 'POST', '/files/download-batch', { fileIds: [mine.id], purpose: 'AUDITORIA', justification: env.JUSTIFICATION });
  assert.equal(batch.status, 403);
  assert.equal((await env.jobsOf('DOWNLOAD')).length, 0, 'recusado antes do guard: nenhum pedido');
  await env.setClass(mine.id, 'HIGH');
  assert.equal((await http.call('makerA', 'GET', `/files/${mine.id}`)).status, 200, 'com a classe rebaixada por quem gere a classificação, volta a abrir');
});
