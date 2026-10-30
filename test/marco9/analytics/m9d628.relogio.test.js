'use strict';

// M9-D628 / M9-D606 — os sinais técnicos usam o relógio injetável do BI (clock.now()), nunca new Date() direto: com o relógio fixo, o instante gravado, as sondas sem
// instante informado e a retenção partem do relógio fixado, inclusive às 23:30 e às 00:30 de São Paulo. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env628 = require('../_helpers/m9d628Env');
const clock = require('../../../src/features/analytics/metrics/clock');
const tech = require('../../../src/features/analytics/tech-signals');

let env;
before(async () => { env = await env628.setup(); });
after(() => env628.teardown(env));
afterEach(() => clock.resetClock());

const signalsAt = async (instant) => (await env.admin.query('SELECT id, kind, probe FROM analytics.tech_signal_log WHERE occurred_at = :at', { replacements: { at: instant } }))[0];
const track = (rows) => rows.forEach((r) => env.created.push({ table: 'analytics.tech_signal_log', id: r.id }));

for (const [label, iso] of [['23:30 de 28/10 em São Paulo', '2026-10-29T02:30:00Z'], ['00:30 de 29/10 em São Paulo', '2026-10-29T03:30:00Z']]) {
  test(`m9d628 relógio injetável: o sinal sem instante informado e as sondas gravam o instante do relógio fixo (${label})`, async () => {
    const at = new Date(iso);
    clock.setClock(() => at);
    assert.equal(await tech.recordTechSignal({ kind: tech.KINDS.PROBE, probe: 'API', ok: true }), true);
    const out = await tech.runProbes({ probes: ['API', 'DATABASE'], timeoutMs: 2000 });
    assert.deepEqual(Object.keys(out).sort(), ['API', 'DATABASE']);
    const rows = await signalsAt(at);
    track(rows);
    assert.equal(rows.length, 3, 'um sinal avulso e duas sondas, todos no instante do relógio injetado');
  });
}

test('m9d628 relógio injetável: a retenção parte do relógio fixo', async () => {
  const id = await env628.signal(env, { kind: 'PROBE', probe: 'API', ok: true, occurredAt: new Date('2026-09-01T12:00:00Z') });
  clock.setClock(() => new Date('2026-10-29T03:30:00Z'));
  const purged = await env628.sequelize.transaction((tx) => tech.purgeTechSignals({ retentionDays: 30 }, tx));
  assert.ok(purged >= 1);
  assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM analytics.tech_signal_log WHERE id = :id', { replacements: { id } }))[0][0].n, 0);
});

test('m9d628 os arquivos dos sinais técnicos não leem o relógio do servidor', () => {
  const dir = path.join(__dirname, '../../../src/features/analytics/tech-signals');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
    assert.doesNotMatch(code, /new Date\(\s*\)|Date\.now\(/, `${file} deve usar clock.now()`);
  }
});
