'use strict';

// DI-BI-7 (M9-D606 regra 5, M9-D611, DI-BI-5; livro §14 source_snapshot_at) — o read model de integrações e a origem do detalhe (sourceRefs) escolhem a "última janela fechada"
// com a MESMA referência: o relógio do BI no instante do read model, que o filtro assinado carrega. Em 41addaa2 o read model usava o relógio do BI e a origem o now() do
// banco: um milissegundo antes da virada os dois apontavam janelas diferentes e o detalhe não reconciliava com o KPI; e a reconciliação feita depois (prova da M9-D712,
// aceite da M9-D708) pegava a janela que tinha fechado nesse meio-tempo. Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { kit, activeConnection, healthWindow, kpiAt } = require('../_helpers/m9biJanelas');

const CODE = 'tec.integration_errors';
let env;
let conn;
before(async () => {
  env = await kit.setup();
  conn = await activeConnection(env, env.cX);
  await healthWindow(env, env.cX, conn, '2026-10-28T14:00:00Z', { total: 100, failed: 10 }); // fechada às 15:00Z
  await healthWindow(env, env.cX, conn, '2026-10-28T15:00:00Z', { total: 3, failed: 0 }); // fecha às 16:00Z
});
after(() => kit.teardown(env));

/** O snapshot gravado (última revisão da data-base, como o aceite da M9-D708 o lê), o detalhe refeito da origem pelo filtro assinado e a reconciliação com o valor do KPI. */
async function detailOf(t) {
  const [[snap]] = await env.admin.query(
    `SELECT s.value_numeric::text AS value, s.source_refs AS "sourceRefs" FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
      WHERE d.metric_code = :code AND s.company_id = :c AND s.dimension_key = '' AND s.as_of_date = :asOf ORDER BY s.created_at DESC, s.revision_no DESC LIMIT 1`,
    { replacements: { code: CODE, c: t.companyId, asOf: kit.AS_OF } }
  );
  const ref = snap.sourceRefs[0];
  const r = await kit.inTx(t, {}, (tx) => kit.registry.reconcileDetail(kit.ctxOf(t), CODE, ref, snap.value, { unit: 'PERCENT' }, tx));
  return { value: Number(snap.value), ref, ok: r.ok, detail: Number(r.detail) };
}

for (const [instant, want] of [['2026-10-28T15:59:59.999Z', { value: '10.00', calls: '100' }], ['2026-10-28T16:00:00.000Z', { value: '0.00', calls: '3' }]]) {
  test(`DI-BI-7 na virada da janela (${instant}) read model e origem escolhem a mesma janela e o detalhe reconcilia`, async () => {
    const r0 = await kpiAt(env, env.cX, new Date(instant));
    assert.deepEqual([r0.value, r0.details.calls], [want.value, want.calls], 'o read model, no relógio do BI');
    const d = await detailOf(env.cX);
    assert.deepEqual([d.value, d.detail, d.ok], [Number(want.value), Number(want.value), true], `detalhe ${d.detail} x KPI ${d.value}: a origem refez a mesma janela`);
    assert.equal(d.ref.filter.equals.tecClosedBy, instant, 'o filtro assinado carrega o instante do read model');
  });
}

test('DI-BI-7 reconciliação feita depois (17:30Z, com a janela das 16:00Z já fechada) refaz a janela do snapshot, não a mais nova', async () => {
  await healthWindow(env, env.cX, conn, '2026-10-28T16:00:00Z', { total: 50, failed: 25 }); // fecha às 17:00Z: 50,00%
  kit.clock.setClock(new Date('2026-10-28T17:30:00Z'));
  const late = await detailOf(env.cX);
  assert.equal(late.value, 0, 'o snapshot das 16:00Z (janela das 15:00Z) não foi recalculado');
  assert.deepEqual([late.detail, late.ok], [0, true], 'a origem continua na janela que o snapshot leu, não na das 16:00Z (50,00%)');
  const now = await kpiAt(env, env.cX, new Date('2026-10-28T17:30:00Z'));
  assert.deepEqual([now.value, now.details.calls], ['50.00', '50'], 'recalculado às 17:30Z, o indicador passa à janela das 16:00Z');
  const fresh = await detailOf(env.cX);
  assert.deepEqual([fresh.value, fresh.detail, fresh.ok], [50, 50, true]);
});

test('DI-BI-7 nenhuma consulta do BI compara com o now() do banco (só o relógio do BI, M9-D606); now() fica só nos carimbos de gravação', () => {
  const root = path.join(__dirname, '../../../src/features/analytics');
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') && files.push(path.join(dir, e.name))));
  walk(root);
  const compares = /(<=|>=|<|>|-|\+)\s*now\(\)|[^.\w]now\(\)\s*(<=|>=|<|>|-|\+)/; // comparação ou conta com now(); `updated_at = now()` (carimbo) não entra
  const offenders = files.filter((f) => compares.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.ok(files.length > 300, 'a varredura percorreu a camada inteira do BI');
  assert.deepEqual(offenders, []);
});
