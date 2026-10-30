'use strict';

// M9-D862 — os cinco detectores: limiares, fórmulas de desperdício e fontes (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d862.deteccao.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const env = require('../_helpers/m9d862Env');
const { runDetector, byCode } = require('../../../src/features/core-governance/finops/detectors/run');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const go = (code, tx, tenant = tenants.A) => runDetector(tenant, byCode(code), env.NOW, tx);
const open = (tx, code, tenant = tenants.A) => env.findings(tenant, tx, "detector = :d AND status = 'OPEN'", { d: code });

test('m9d862 storage órfão detectado após 30 dias e não antes', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.file(A, tx, { age: 45, bytes: 1000 });
    await env.file(A, tx, { age: 10, bytes: 5000 });
    const linked = await env.file(A, tx, { age: 60 });
    await env.link(A, tx, linked.id);
    await env.file(A, tx, { age: 60, uploader: A.userId }); // dono ativo
    const out = await go('ORPHAN_STORAGE', tx);
    assert.equal(out.ok, true);
    const rows = await open(tx, 'ORPHAN_STORAGE');
    assert.deepEqual(rows.map((r) => r.subject), ['files:orfaos']);
    assert.deepEqual([rows[0].evidence.arquivos, rows[0].evidence.bytes], [1, '1000'], 'só o de 45 dias, sem vínculo e sem dono');
    await upsertSetting('governanca.finops.orfao_dias', 90, A, A.userId, tx);
    await go('ORPHAN_STORAGE', tx);
    assert.deepEqual((await open(tx, 'ORPHAN_STORAGE')).length, 0, 'com 90 dias de corte o de 45 não é órfão (parâmetro) e o achado resolve');
  });
});

test('m9d862 storage órfão estima desperdício por GB-mês e vê o bucket sem linha', { skip: skip() }, async () => {
  const b = env.bucket(tenants.A);
  try {
    await run(async (tx) => {
      const A = tenants.A;
      for (let i = 0; i < 120; i += 1) await env.file(A, tx, { age: 45, bytes: 1024 ** 3 }); // 120 arquivos de 1 GB = 120 GB (a coluna size_bytes é inteira de 32 bits)
      const known = await env.file(A, tx, { age: 45, uploader: A.userId, key: `docs/${A.groupId}/conhecido.bin` });
      b.put(`docs/${A.groupId}/conhecido.bin`, { bytes: 300 });
      const orphanFile = b.put(`docs/${A.groupId}/sem-linha.bin`, { bytes: 700 });
      b.put(`docs/${A.groupId}/recente.bin`, { bytes: 900, ageDays: 1 });
      b.put(`docs/${A.groupId}/sem-linha.bin.meta`, { bytes: 50 });
      await go('ORPHAN_STORAGE', tx);
      const rows = await open(tx, 'ORPHAN_STORAGE');
      const files = rows.find((r) => r.subject === 'files:orfaos');
      const bucket = rows.find((r) => r.subject === 'bucket:sem-linha');
      assert.equal(files.estimated_waste_cents, '1200', '120 GB x R$ 0,10 por GB-mês = R$ 12,00');
      assert.deepEqual([bucket.evidence.objetos, bucket.evidence.bytes], [1, '700'], 'só o objeto antigo sem linha; .meta, recente e conhecido ficam de fora');
      assert.ok(fs.existsSync(orphanFile) && known.id, 'o detector não apaga nada');
    });
  } finally { b.cleanup(); }
});

test('m9d862 fila acima de 5.000 abre finding', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.outbox(A, tx, 5000);
    await go('QUEUE_BACKLOG', tx);
    assert.equal((await open(tx, 'QUEUE_BACKLOG')).length, 0, '5.000 exatos não passam do limite');
    await env.outbox(A, tx, 1200); // 6.200 pendentes, como o exemplo do livro
    await go('QUEUE_BACKLOG', tx);
    const [row] = await open(tx, 'QUEUE_BACKLOG');
    assert.deepEqual([row.subject, row.estimated_waste_cents, row.evidence.pendentes, row.evidence.informativo], ['outbox', '0', 6200, true], 'fila é informativa: desperdício 0');
  });
});

test('m9d862 um único evento velho na fila não abre finding', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.outbox(A, tx, 1, { ageMin: 180 });
    await env.outbox(A, tx, 100);
    await go('QUEUE_BACKLOG', tx);
    assert.equal((await open(tx, 'QUEUE_BACKLOG')).length, 0, 'um evento de 3 horas não basta');
    await env.outbox(A, tx, 48, { ageMin: 31 }); // 49 velhos
    await go('QUEUE_BACKLOG', tx);
    assert.equal((await open(tx, 'QUEUE_BACKLOG')).length, 0, '49 velhos ainda não');
    await env.outbox(A, tx, 1, { ageMin: 45 }); // 50 velhos
    await go('QUEUE_BACKLOG', tx);
    assert.equal((await open(tx, 'QUEUE_BACKLOG')).length, 1, '50 eventos mais velhos que 30 minutos abrem o achado');
    await env.outbox(A, tx, 100, { status: 'SENT', ageMin: 600 });
  });
});

test('m9d862 egress 3,5x a média abre finding', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const GB = 1024 ** 3;
    await env.volumes(A, tx, { category: 'EGRESS', unit: 'bytes', service: 'egress:download' }, [...Array(14).fill(2 * GB), 7 * GB]);
    await go('EGRESS', tx);
    const [row] = await open(tx, 'EGRESS');
    assert.equal(row.subject, 'egress:PROD');
    assert.equal(row.evidence.vezesAMedia, 3.5);
    assert.equal(row.estimated_waste_cents, String(5 * 50), '(7 - 2) GB x R$ 0,50 = R$ 2,50');
  });
});

test('m9d862 egress abaixo do limiar ou sem histórico não abre', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const GB = 1024 ** 3;
    await env.volumes(A, tx, { category: 'EGRESS', unit: 'bytes', service: 'egress:download' }, [...Array(14).fill(2 * GB), 6 * GB]);
    await go('EGRESS', tx);
    assert.equal((await open(tx, 'EGRESS')).length, 0, 'exatamente 3x não passa (acima de)');
  });
  await run(async (tx) => {
    await env.volumes(tenants.B, tx, { category: 'EGRESS', unit: 'bytes', service: 'egress:download' }, [9 * 1024 ** 3], env.DAY);
    await go('EGRESS', tx, tenants.B);
    assert.equal((await open(tx, 'EGRESS', tenants.B)).length, 0, 'sem dias anteriores não há média para comparar');
  }, tenants.B);
});

test('m9d862 modelo caro em tarefa simples abre finding', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.aiRuns(A, tx, { n: 10, model: 'modelo-caro', cost: '0.80' });
    await env.aiRuns(A, tx, { n: 10, model: 'modelo-barato', cost: '0.10' });
    await env.aiRuns(A, tx, { n: 10, model: 'modelo-caro-avancado', cost: '5.00', path: 'ADVANCED_MODEL' });
    await env.aiRuns(A, tx, { n: 10, model: 'modelo-caro-cache', cost: '5.00', cached: true, path: 'CACHE' });
    await go('AI_MODEL_COST', tx);
    const rows = await open(tx, 'AI_MODEL_COST');
    assert.deepEqual(rows.map((r) => r.subject), ['qa-prov/modelo-caro']);
    assert.equal(rows[0].estimated_waste_cents, String((80 - 50) * 10), '(custo médio 80 - limiar 50) x 10 chamadas');
    assert.deepEqual([rows[0].evidence.chamadas, rows[0].evidence.custoMedioCentavos], [10, 80]);
  });
});

test('m9d862 logs 3x a média abrem finding', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.volumes(A, tx, { category: 'STORAGE', unit: 'GB', service: 'logs', shared: true }, [...Array(14).fill('1.000000'), '3.000000']);
    await go('LOG_VOLUME', tx);
    assert.equal((await open(tx, 'LOG_VOLUME')).length, 0, 'exatamente 3x não passa');
    await env.volumes(A, tx, { category: 'STORAGE', unit: 'GB', service: 'logs', shared: true }, ['3.500000']);
    // o dia ganha uma segunda linha de 3,5 GB: o volume do dia vira 6,5 GB, acima de 3x
    await go('LOG_VOLUME', tx);
    assert.equal((await open(tx, 'LOG_VOLUME')).length, 1);
  });
});

test('m9d862 volume de log vem do ledger e o desperdício usa a fórmula', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.volumes(A, tx, { category: 'STORAGE', unit: 'GB', service: 'logs', shared: true }, [...Array(14).fill('2.000000'), '8.000000']);
    await go('LOG_VOLUME', tx);
    const [row] = await open(tx, 'LOG_VOLUME');
    assert.deepEqual([row.evidence.volumeGb, row.evidence.averageGb, row.evidence.vezesAMedia], ['8.000000', '2.000000', 4]);
    assert.equal(row.estimated_waste_cents, String((8 - 2) * 10), '(8 GB - média 2 GB) x R$ 0,10 por GB');
    await env.volumes(A, tx, { category: 'STORAGE', unit: 'GB', service: 'outro', shared: true }, ['50.000000']);
    await go('LOG_VOLUME', tx);
    assert.equal((await open(tx, 'LOG_VOLUME'))[0].evidence.volumeGb, '8.000000', 'só a linha service = logs conta');
  });
});
