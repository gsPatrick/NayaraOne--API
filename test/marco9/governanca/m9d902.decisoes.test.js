'use strict';

// M9-D902 (reabertura M1) — toda decisão do corte exige o papel RACI da atividade: avançar o canary (SECTOR_ACTIVATION), reverter o setor (ROLLBACK_EXECUTION), GO/NO-GO (GO_NO_GO) e a
// última carga delta (LAST_DELTA_LOAD). Quem tem a permissão da rota mas não é R nem A recebe 403 GOV_MIG_RACI_FORBIDDEN, uma decisão por vez, e nada é gravado. Banco descartável. Nunca chama MFA.
process.env.PORT = process.env.M9D902_DEC_TEST_PORT || '21912';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d904Env');
const http = require('../_helpers/m9d806Http');
const base = require('../_helpers/m9d904Base');
const { grantRaci } = require('../_helpers/m9d902Raci');

const PERMS = ['governance:migration:run', 'governance:migration:admin', 'governance:flags:manage'];
let h; let A;
const call = (method, path, body) => h.call('gestor', method, path, body);

async function grant(on) {
  await env.adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)', ['CI GESTOR', PERMS]);
  if (on) {
    await env.adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
      SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2)`, ['CI GESTOR', PERMS]);
  }
}

before(async () => {
  await grant(true);
  h = await http.startHttp({ port: process.env.PORT, grants: {}, logins: { gestor: ['A', 'gestor'] } });
  if (h.skip) return;
  A = h.tenants.A;
  await env.cleanup(A);
});
afterEach(async () => { if (h && !h.skip) await env.cleanup(A); });
after(async () => { if (h && !h.skip) { await grant(false); await env.cleanup(A); } await http.stopHttp({}); });

const DECISIONS = [
  ['SECTOR_ACTIVATION', 'POST', '/migration/canary/ATENDIMENTO/advance', {}],
  ['ROLLBACK_EXECUTION', 'POST', '/migration/canary/ATENDIMENTO/rollback', { reason: 'ensaio' }],
  ['GO_NO_GO', 'POST', '/migration/cutover/decision', { decision: 'NO_GO', reason: 'ensaio' }],
  // entidade desconhecida: passando do RACI o pedido para em 422 e nenhuma execução real é criada
  ['LAST_DELTA_LOAD', 'POST', '/migration/runs', { sourceSystem: 'LEGADO_ERP', entity: 'QA_NAO_EXISTE', lastDelta: true }],
];

for (const [activity, method, path, body] of DECISIONS) {
  test(`m9d902 decisão ${activity}: quem não é R nem A recebe 403 GOV_MIG_RACI_FORBIDDEN e só R ou A passa`, async (t) => {
    if (h.skip) return t.skip(h.skip);
    const decisionsBefore = (await env.adminQuery('SELECT count(*)::int AS n FROM governance.cutover_decisions WHERE company_id = $1', [A.companyId])).rows[0].n;
    const runsBefore = (await env.adminQuery('SELECT count(*)::int AS n FROM governance.mig_runs WHERE company_id = $1', [A.companyId])).rows[0].n;
    await grantRaci(A, 'QA-M9 OUTRO PAPEL', [activity]); // o gestor tem a permissão da rota, mas o R é de outro papel
    const denied = await call(method, path, body);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.deepEqual([denied.body.error.code, denied.body.error.details && denied.body.error.details.activity], ['GOV_MIG_RACI_FORBIDDEN', activity]);
    assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.cutover_decisions WHERE company_id = $1', [A.companyId])).rows[0].n, decisionsBefore, 'nada foi gravado');
    assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.mig_runs WHERE company_id = $1', [A.companyId])).rows[0].n, runsBefore);
    assert.equal(await env.percentOf(A, 'ATENDIMENTO'), 0);

    await grantRaci(A, 'CI GESTOR', [activity]); // agora o papel do gestor é R
    await base.ensureCleanBase(A);
    const passed = await call(method, path, body);
    assert.notEqual(passed.body.error && passed.body.error.code, 'GOV_MIG_RACI_FORBIDDEN', JSON.stringify(passed.body));
    // passou do RACI e parou onde a rota segue: 200 no avanço e no NO_GO, 422 na entidade inválida da carga delta, 403 de MFA no rollback
    assert.equal(passed.status, { SECTOR_ACTIVATION: 200, GO_NO_GO: 200, LAST_DELTA_LOAD: 422, ROLLBACK_EXECUTION: 403 }[activity], JSON.stringify(passed.body));
  });
}
