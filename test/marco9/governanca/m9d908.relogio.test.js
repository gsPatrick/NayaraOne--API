'use strict';

// M9-D908 §3.1 — validação de relógio antes de cada lote: deriva acima do limite bloqueia (blocker da Torre e pausa do aplicador), volta ao limite fecha o blocker e retoma sozinho
// do último checkpoint; o NTP é lido de um servidor UDP de verdade (local). Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const env = require('../_helpers/m9d908Env');
const gate = require('../../../src/features/migration-v2/clock/clock.gate');
const { queryNtp } = require('../../../src/features/migration-v2/clock/ntp.reader');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (!env.DISPOSABLE) return; A = (await env.loadTenants()).A; await env.cleanup(A); await env.isolate(A); });
afterEach(async () => { if (env.DISPOSABLE) { await env.cleanup(A); await env.isolate(A); } });
after(async () => { if (env.DISPOSABLE) await env.cleanup(A); await env.sequelize.close(); });

/** Fonte antiga cujo relógio anda `state.offsetMs` à frente do da aplicação. */
async function legacyWithClock(offsetMs) {
  const legacy = await env.installSource(A, { mode: 'WATERMARK', entity: 'PERSON' });
  const state = { offsetMs };
  legacy.fake.connector.readClock = async () => new Date(Date.now() + state.offsetMs);
  return { legacy, state };
}

test('m9d908 deriva de relógio acima do limite bloqueia', { skip: skip() }, async () => {
  const { legacy, state } = await legacyWithClock(5000);
  try {
    const result = await env.checkClock(A, { context: 'MANUAL' });
    assert.equal(result.status, 'DRIFT');
    assert.ok(result.driftMs >= 4900 && result.driftMs <= 5500, `deriva medida ${result.driftMs}`);
    assert.equal(result.maxDriftMs, 2000);
    assert.deepEqual(result.readings.map((r) => r.system).sort(), ['APP', 'DB', `SOURCE:${legacy.system}`].sort());
    // o portão do lote recusa com o código e a mensagem do livro
    const refused = await env.fail(gate.beforeBatch(A, { runId: null, source: { source_system: legacy.system }, connector: legacy.fake.connector }));
    assert.deepEqual([refused.status, refused.code, refused.message], [409, 'GOV_MIG_CLOCK_DRIFT', 'Os relógios dos sistemas diferem além do permitido.']);
    // a Torre abre o blocker; dentro do limite (1 s < 2 s) ele fecha
    const blockers = (await env.towerBlockers(A, 'GOV_MIG_CLOCK_DRIFT'));
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].detail.max_drift_ms, 2000);
    state.offsetMs = 1000;
    assert.equal((await env.checkClock(A)).status, 'OK');
    assert.equal((await env.towerBlockers(A, 'GOV_MIG_CLOCK_DRIFT')).length, 0, 'o blocker sai quando a deriva volta ao limite');
    const closed = await env.adminQuery("SELECT count(*)::int AS n FROM governance.mig_blockers WHERE company_id = $1 AND code = 'GOV_MIG_CLOCK_DRIFT' AND closed_at IS NOT NULL", [A.companyId]);
    assert.equal(closed.rows[0].n, 1);
  } finally { legacy.dispose(); }
});

test('m9d908 o limite da deriva é o parâmetro migracao.relogio.deriva_max_s', { skip: skip() }, async () => {
  const { legacy } = await legacyWithClock(3000);
  try {
    assert.equal((await env.checkClock(A)).status, 'DRIFT', 'padrão 2 s: 3 s bloqueia');
    await env.setParam(A, 'migracao.relogio.deriva_max_s', 10);
    const loose = await env.checkClock(A);
    assert.deepEqual([loose.status, loose.maxDriftMs], ['OK', 10000]);
  } finally { legacy.dispose(); }
});

test('m9d908 leitura que falha vira relógio não medido e o lote não parte', { skip: skip() }, async () => {
  const off = env.clockReaders.register('QA908_BROKEN', async () => { throw new Error('sem resposta'); });
  try {
    const result = await env.checkClock(A);
    assert.equal(result.status, 'UNMEASURED');
    assert.ok(result.readings.some((r) => r.system === 'QA908_BROKEN' && r.error));
    const refused = await env.fail(gate.beforeBatch(A, { runId: null }));
    assert.equal(refused.code, 'GOV_MIG_CLOCK_UNMEASURED');
    assert.deepEqual(await env.towerCodes(A).then((codes) => codes.filter((c) => c.startsWith('GOV_MIG_CLOCK'))), ['GOV_MIG_CLOCK_UNMEASURED']);
  } finally { off(); }
});

test('m9d908 aplicador pausado por deriva retoma sozinho quando a medição volta ao limite', { skip: skip() }, async () => {
  const { legacy, state } = await legacyWithClock(8000);
  try {
    legacy.fake.row('k1', new Date('2030-01-01T00:00:00Z'), env.personRecord());
    legacy.fake.row('k2', new Date('2030-01-01T00:00:01Z'), env.personRecord());
    const first = await env.run(A, { sourceSystem: legacy.system, entity: 'PERSON' });
    assert.equal(first.result.status, 'PAUSED', 'o aplicador parou antes do lote');
    const paused = await env.runRow(first.runId);
    assert.equal(paused.status, 'PAUSED');
    assert.equal((await env.recordsOf(legacy.system)).length, 0, 'nenhum lote foi aplicado');
    assert.equal((await legacy.source()).checkpoint_token, null, 'o checkpoint não andou');
    // antes dos 5 minutos a conferência não repete; relógio ainda errado: continua pausado
    const early = await env.recheckAndResume(A, { now: new Date(Date.now() + 60000) });
    assert.deepEqual([early.checked, early.resumed], [false, []]);
    const still = await env.recheckAndResume(A, { now: new Date(Date.now() + 6 * 60000) });
    assert.deepEqual([still.checked, still.status, still.resumed], [true, 'DRIFT', []]);
    assert.equal((await env.runRow(first.runId)).status, 'PAUSED');
    // a medição volta ao limite: a execução volta à fila sozinha e termina do checkpoint
    state.offsetMs = 0;
    const back = await env.recheckAndResume(A, { now: new Date(Date.now() + 12 * 60000) });
    assert.deepEqual([back.checked, back.status, back.resumed], [true, 'OK', [first.runId]], JSON.stringify((await env.lastClock(A)).readings));
    assert.equal((await env.runRow(first.runId)).status, 'QUEUED');
    const resumed = await require('../../../src/features/migration-v2/ingest/executor').executeRun(A, first.runId);
    assert.equal(resumed.status, 'SUCCEEDED');
    assert.equal((await env.recordsOf(legacy.system)).filter((r) => r.state === 'MIGRATED').length, 2);
    assert.equal((await env.towerBlockers(A, 'GOV_MIG_CLOCK_DRIFT')).length, 0);
    assert.deepEqual((await env.adminQuery("SELECT action FROM audit.audit_log WHERE company_id = $1 AND entity_id = $2 AND action IN ('migration.run.paused', 'migration.run.resumed') ORDER BY occurred_at", [A.companyId, first.runId])).rows.map((r) => r.action), ['migration.run.paused', 'migration.run.resumed']);
  } finally { legacy.dispose(); }
});

test('m9d908 o intervalo da reverificação é o parâmetro migracao.relogio.reverificar_min', { skip: skip() }, async () => {
  const { legacy } = await legacyWithClock(8000);
  try {
    legacy.fake.row('k1', new Date('2030-01-01T00:00:00Z'), env.personRecord());
    const first = await env.run(A, { sourceSystem: legacy.system, entity: 'PERSON' });
    assert.equal(first.result.status, 'PAUSED');
    await env.setParam(A, 'migracao.relogio.reverificar_min', 1);
    const soon = await env.recheckAndResume(A, { now: new Date(Date.now() + 2 * 60000) });
    assert.equal(soon.checked, true, 'com 1 minuto a conferência repete aos 2');
  } finally { legacy.dispose(); }
});

/** Servidor SNTP local: responde com o relógio deslocado de `skewMs`. */
function ntpServer(skewMs) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, remote) => {
    const reply = Buffer.alloc(48);
    reply[0] = 0x1c;
    const put = (at, ms) => { const s = ms / 1000 + 2208988800; reply.writeUInt32BE(Math.floor(s), at); reply.writeUInt32BE(Math.floor((s % 1) * 4294967296), at + 4); };
    put(32, Date.now() + skewMs);
    put(40, Date.now() + skewMs);
    socket.send(reply, remote.port, remote.address);
  });
  return new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket)));
}

test('m9d908 o NTP é lido por UDP do servidor do parâmetro e entra na conferência', { skip: skip() }, async () => {
  const server = await ntpServer(4000);
  const { readNtp } = require('../../../src/features/migration-v2/clock/ntp.reader');
  try {
    assert.ok(Math.abs(await queryNtp(`127.0.0.1:${server.address().port}`, 2000) - 4000) < 300, 'o deslocamento medido é o do servidor');
    await env.setParam(A, 'migracao.relogio.ntp_servidor', `127.0.0.1:${server.address().port}`);
    const read = await readNtp({ tenant: env.tenantOf(A) });
    assert.equal(read[0].system, 'NTP');
    assert.ok(read[0].offsetMs >= 3700 && read[0].offsetMs <= 4300, `deslocamento NTP ${read[0].offsetMs}`);
    const off = env.clockReaders.register('NTP', readNtp);
    try {
      const result = await env.checkClock(A);
      assert.equal(result.status, 'DRIFT', 'o NTP 4 s à frente passa do limite de 2 s');
      assert.ok(result.readings.some((r) => r.system === 'NTP'));
    } finally { off(); }
    await env.setParam(A, 'migracao.relogio.ntp_ativo', false);
    assert.deepEqual(await readNtp({ tenant: env.tenantOf(A) }), [], 'NTP desligado pelo parâmetro: nenhuma leitura');
    await env.setParam(A, 'migracao.relogio.ntp_ativo', true);
    await env.setParam(A, 'migracao.relogio.ntp_servidor', '127.0.0.1:9');
    await env.setParam(A, 'migracao.relogio.ntp_timeout_ms', 200);
    const started = Date.now();
    await assert.rejects(readNtp({ tenant: env.tenantOf(A) }), /NTP_TIMEOUT|ECONNREFUSED/);
    assert.ok(Date.now() - started < 1500, 'o tempo máximo é o parâmetro ntp_timeout_ms');
  } finally { server.close(); }
});
