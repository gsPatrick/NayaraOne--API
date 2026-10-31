'use strict';

// M9-D920 §3.1 — impressão: POST /dlp/print-events passa pelo guard antes da visão de impressão; o PDF sai por endereço assinado de uso único, com rodapé em toda página, marca
// d'água quando a política da classe a liga ou o usuário a pede, campos mascarados e auditoria dlp.print. API real em banco descartável.
// porta aleatória: portas fixas colidem com a API de outro teste que esteja de pé ao mesmo tempo
process.env.PORT = process.env.M9D920_PRINT_TEST_PORT || String(30000 + Math.floor(Math.random() * 20000));

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d920Env');
const { contratoComAnexo } = require('../_helpers/m9d809Legal');
const { maskForPrint } = require('../../../src/features/core-governance/dlp/print/print.mask');
const { toLines } = require('../../../src/features/core-governance/dlp/print/print.render');

let http; let A; let restore; let contractId;
const LEGAL = 'legal:read';
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await env.withRolePermissions({ 'CI GESTOR': { [LEGAL]: true }, 'CI MAKER': { [LEGAL]: false } });
  http = await env.start(process.env.PORT);
  A = http.tenants.A;
  contractId = (await contratoComAnexo(A)).contractId;
});
afterEach(async () => { if (env.DISPOSABLE) await env.reset(); });
after(async () => { if (env.DISPOSABLE) { await env.reset(); await restore(); } await stopHttp({}); });

const body = (over = {}) => ({ resourceType: 'legal.contract', resourceId: contractId, purpose: 'CLIENTE_SOLICITOU', justification: env.JUSTIFICATION, ...over });
const printJobs = () => env.jobsOf('PRINT');
const nameOf = async (userId) => { const { rows: [u] } = await env.adminQuery('SELECT name, email FROM core.users WHERE id = $1', [userId]); return u.name || u.email; };

test('m9d920 impressão RESTRICTED exige MFA e registra tentativa', { skip: skip() }, async () => {
  env.resolver.setResolver(async (_tenant, resources) => resources.map(() => 'RESTRICTED'));
  await env.revokeMfa(A.userId);
  const res = await http.call('gestorA', 'POST', '/dlp/print-events', body());
  assert.equal(res.status, 403);
  assert.deepEqual([res.body.error.code, res.body.error.message], ['MFA_STEP_UP_REQUIRED', 'Confirme o código de verificação para continuar.']);
  const [job] = await printJobs();
  assert.deepEqual([job.id, job.status, job.block_reason, job.classification, job.action, job.kind], [res.body.error.details.exportJobId, 'BLOCKED', 'MFA', 'RESTRICTED', 'PRINT', 'PRINT'], 'a tentativa fica em export_jobs (kind PRINT)');
  assert.deepEqual(job.resource_ref.resourceIds, [contractId]);
  await env.grantMfa(A);
  await env.clearSignals();
  const ok = await http.call('gestorA', 'POST', '/dlp/print-events', body());
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.classification, 'RESTRICTED');
});

test('m9d920 print-events devolve 201 com printUrl e o bloqueio devolve job BLOCKED', { skip: skip() }, async () => {
  const noWhy = await http.call('gestorA', 'POST', '/dlp/print-events', body({ justification: 'curta' }));
  assert.deepEqual([noWhy.status, noWhy.body.error.code], [422, 'GOV_DLP_PURPOSE_REQUIRED']);
  assert.equal(noWhy.body.error.message, 'Informe a finalidade e uma justificativa com pelo menos 20 caracteres.');
  assert.deepEqual((await printJobs()).map((j) => j.status), ['BLOCKED']);
  const before = Date.now();
  const ok = await http.call('gestorA', 'POST', '/dlp/print-events', body());
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  for (const key of ['exportJobId', 'status', 'printUrl']) assert.ok(key in ok.body.data, key);
  assert.equal(ok.body.data.status, 'APPROVED');
  assert.match(ok.body.data.printUrl, new RegExp(`^/api/v1/dlp/print-events/${ok.body.data.exportJobId}/pdf\\?exp=\\d+&sig=[0-9a-f]{64}$`));
  const job = (await printJobs()).find((j) => j.id === ok.body.data.exportJobId);
  const minutes = (new Date(job.expires_at) - before) / 60000;
  assert.ok(minutes > 14.5 && minutes < 15.5, `o endereço vale 15 minutos (governanca.dlp.impressao.url_min), deu ${minutes}`);
  assert.deepEqual([job.status, job.classification, job.watermark], ['APPROVED', 'HIGH', false]);
  const again = await http.call('gestorA', 'POST', '/dlp/print-events', body());
  assert.notEqual(again.body.data.exportJobId, ok.body.data.exportJobId, 'reimpressão gera novo evento');
});

test('m9d920 o PDF de impressão tem o rodapé em toda página, sai uma vez só e é auditado', { skip: skip() }, async () => {
  const asked = await http.call('gestorA', 'POST', '/dlp/print-events', body());
  const got = await env.raw(http, 'gestorA', asked.body.data.printUrl);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.equal(got.headers.get('x-watermark'), 'none');
  const buffer = Buffer.from(await got.arrayBuffer());
  assert.equal(buffer.latin1Slice(0, 5), '%PDF-');
  const text = env.pdfText(buffer);
  const who = await nameOf(A.userId);
  assert.match(text, /Impresso por CI gestor .{1,3} tenant A em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} . documento /, 'rodapé: quem imprimiu, quando e o documento (o travessão do nome sai em WinAnsi)');
  assert.equal(who, 'CI gestor — tenant A');
  assert.match(text, new RegExp(`documento ${contractId}`));
  assert.match(text, /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/, 'data e hora no fuso configurado');
  assert.match(text, /Contrato/);
  assert.ok(!/Nayara One ·/.test(text), 'sem marca quando a política não a liga e o usuário não pediu');
  const audit = (await env.adminQuery("SELECT after_json FROM audit.audit_log WHERE action = 'dlp.print' AND entity_id = $1", [asked.body.data.exportJobId])).rows;
  assert.equal(audit.length, 1);
  assert.ok(audit[0].after_json.ip && audit[0].after_json.userAgent && audit[0].after_json.resourceId === contractId);

  const second = await env.raw(http, 'gestorA', asked.body.data.printUrl);
  assert.deepEqual([second.status, (await second.json()).error.code], [410, 'GOV_DOWNLOAD_ALREADY_USED']);
  const third = await http.call('gestorA', 'POST', '/dlp/print-events', body());
  assert.equal((await env.raw(http, 'makerA', third.body.data.printUrl)).status, 403, 'o endereço é de quem pediu');
  const bad = await env.raw(http, 'gestorA', third.body.data.printUrl.replace(/sig=[0-9a-f]{64}/, `sig=${'0'.repeat(64)}`));
  assert.deepEqual([bad.status, (await bad.json()).error.code], [403, 'GOV_EXPORT_LINK_INVALID']);
  await env.adminQuery("UPDATE governance.export_jobs SET expires_at = now() - interval '1 second' WHERE id = $1", [third.body.data.exportJobId]);
  const gone = await env.raw(http, 'gestorA', third.body.data.printUrl);
  assert.deepEqual([gone.status, (await gone.json()).error.code], [410, 'GOV_EXPORT_EXPIRED']);
});

test('m9d920 marca d\'água na impressão: pedida pelo usuário ou ligada pela política da classe', { skip: skip() }, async () => {
  const asked = await http.call('gestorA', 'POST', '/dlp/print-events', body({ watermark: true }));
  assert.equal(asked.body.data.watermark, true);
  const got = await env.raw(http, 'gestorA', asked.body.data.printUrl);
  assert.equal(got.headers.get('x-watermark'), 'applied');
  const text = env.pdfText(Buffer.from(await got.arrayBuffer()));
  assert.match(text, /Nayara One . CI gestor .{1,3} tenant A . \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} . [0-9a-f-]{36}/, 'marca por usuário, data e pedido');
  assert.ok(text.includes('Impresso por'), 'o rodapé continua em PDF marcado');

  await env.adminQuery("UPDATE governance.dlp_policies SET require_watermark = true WHERE company_id = $1 AND classification = 'HIGH' AND action = 'PRINT'", [A.companyId]);
  const byPolicy = await http.call('gestorA', 'POST', '/dlp/print-events', body());
  assert.equal(byPolicy.body.data.watermark, true, 'a política da classe liga a marca sem o usuário pedir');
});

test('m9d920 rodapé e fuso são parâmetros da empresa', { skip: skip() }, async () => {
  await env.setSetting(A, 'governanca.dlp.impressao.rodape', 'Cópia de {usuario} · {data} · ref {documento}');
  await env.setSetting(A, 'governanca.dlp.impressao.fuso', 'UTC');
  try {
    const asked = await http.call('gestorA', 'POST', '/dlp/print-events', body());
    const text = env.pdfText(Buffer.from(await (await env.raw(http, 'gestorA', asked.body.data.printUrl)).arrayBuffer()));
    assert.ok(text.includes(`ref ${contractId}`) && text.includes('Cópia de '), text.slice(-300));
    const now = new Date();
    const utc = `${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, '0')}:`;
    assert.ok(text.includes(utc), 'a hora sai no fuso configurado');
  } finally { await env.clearSetting(A, 'governanca.dlp.impressao.rodape'); await env.clearSetting(A, 'governanca.dlp.impressao.fuso'); }
});

test('m9d920 pedido de impressão inválido, de outra empresa ou sem a permissão do módulo é recusado', { skip: skip() }, async () => {
  const kind = await http.call('gestorA', 'POST', '/dlp/print-events', body({ resourceType: 'finance.entries' }));
  assert.deepEqual([kind.status, kind.body.error.code], [400, 'GOV_PRINT_RESOURCE_INVALID']);
  const file = await http.call('gestorA', 'POST', '/dlp/print-events', body({ resourceType: 'files.file' }));
  assert.equal(file.body.error.code, 'GOV_PRINT_RESOURCE_INVALID', 'arquivo avulso baixa-se pelo DLP de anexos');
  const id = await http.call('gestorA', 'POST', '/dlp/print-events', body({ resourceId: 'x' }));
  assert.deepEqual([id.status, id.body.error.code], [400, 'GOV_DLP_REQUEST_INVALID']);
  const missing = await http.call('gestorA', 'POST', '/dlp/print-events', body({ resourceId: '00000000-0000-4000-8000-000000000000' }));
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'GOV_NOT_FOUND']);
  const foreign = await http.call('gestorB', 'POST', '/dlp/print-events', body());
  assert.equal(foreign.status, 404, 'o contrato da empresa A não existe para a B');
  const noPerm = await http.call('makerA', 'POST', '/dlp/print-events', body());
  assert.deepEqual([noPerm.status, noPerm.body.error.code], [403, 'GOV_DLP_PERMISSION']);
  assert.equal((await printJobs()).filter((j) => j.status === 'BLOCKED' && j.block_reason === 'PERMISSION').length, 1, 'a recusa por permissão também fica registrada');
  const anon = await fetch(`${http.baseUrl}/dlp/print-events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
  assert.equal(anon.status, 401);
});

test('m9d920 campos mascarados continuam mascarados na impressão', () => {
  const fields = { id: 'LOW', totalValue: 'HIGH', 'parties.name': 'HIGH', 'parties.taxId': 'RESTRICTED' };
  const data = { id: 'c1', totalValue: '1500', parties: [{ name: 'Maria', taxId: '123.456.789-09' }], extra: 'sem classe' };
  const clear = maskForPrint(data, fields, { canViewRestricted: true, maskText: '***' });
  assert.deepEqual(clear, data, 'com a permissão dedicada, tudo em claro (campo sem classe vale HIGH)');
  const masked = maskForPrint(data, fields, { canViewRestricted: false, maskText: '***' });
  assert.deepEqual(masked, { id: 'c1', totalValue: '1500', parties: [{ name: 'Maria', taxId: '***' }], extra: 'sem classe' });
  assert.deepEqual(toLines({ a: 1, b: { c: null } }).map((l) => l.text), ['a: 1', 'b', 'c: —']);
});

test('m9d920 PDF de impressão com várias páginas leva o rodapé e a numeração em todas', async () => {
  const { renderPrintPdf } = require('../../../src/features/core-governance/dlp/print/print.render');
  const data = { itens: Array.from({ length: 150 }, (_x, i) => ({ descricao: `Item ${i + 1}`, valor: i })) };
  const buffer = await renderPrintPdf({ title: 'Relatório', data, footer: 'Impresso por Maria em 30/10/2026 10:00 · documento d-1', watermarkText: 'Nayara One · Maria' });
  const text = env.pdfText(buffer);
  const pages = (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 3, `o relatório ocupa várias páginas (${pages})`);
  assert.equal((text.match(/Impresso por Maria em 30\/10\/2026 10:00/g) || []).length, pages, 'o rodapé está em toda página');
  for (let i = 1; i <= pages; i += 1) assert.ok(text.includes(`página ${i} de ${pages}`), `página ${i}`);
  assert.equal((text.match(/Nayara One . Maria/g) || []).length, pages, 'a marca está em toda página');
});
