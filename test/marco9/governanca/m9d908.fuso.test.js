'use strict';

// M9-D908 §3.2 — validação de fuso: horário inexistente vai à quarentena, horário ambíguo segue a regra configurada, data pura não muda de dia e o fuso de origem é o parâmetro.
// Pelo aplicador de verdade (campo de data e hora acrescentado ao esquema de PERSON) e pelo conversor puro. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d908Env');
const { localToUtc } = require('../../../src/features/migration-v2/timezone/timezone.convert');
const { civilDay } = require('../../../src/features/migration-v2/timezone/timezone.normalize');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const SP = 'America/Sao_Paulo';
before(async () => { if (!env.DISPOSABLE) return; A = (await env.loadTenants()).A; await env.cleanup(A); await env.isolate(A); await env.addInstantField(A); });
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  const keep = await env.adminQuery("SELECT 1 FROM governance.mig_entity_schema WHERE company_id = $1 AND field = 'qa908At'", [A.companyId]);
  await env.cleanup(A);
  await env.isolate(A);
  if (keep.rows.length) await env.addInstantField(A);
});
after(async () => { if (env.DISPOSABLE) await env.cleanup(A); await env.sequelize.close(); });

/** Uma pessoa pelo aplicador de verdade; devolve o registro de origem (estado, motivo, conteúdo gravado). */
async function migrate(extra) {
  const legacy = await env.installSource(A, { mode: 'WATERMARK', entity: 'PERSON' });
  try {
    legacy.fake.row('p1', new Date('2030-01-01T00:00:00Z'), env.personRecord(extra));
    const { result } = await env.run(A, { sourceSystem: legacy.system, entity: 'PERSON' });
    assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result));
    return (await env.recordsOf(legacy.system))[0];
  } finally { legacy.dispose(); }
}

test('m9d908 hora inexistente de 2018 vai para quarentena', { skip: skip() }, async () => {
  assert.equal(localToUtc('2018-11-04 00:30', SP).status, 'NONEXISTENT');
  const record = await migrate({ qa908At: '2018-11-04 00:30' });
  assert.equal(record.state, 'QUARANTINED');
  assert.match(record.reason, /^GOV_MIG_TZ_NONEXISTENT_LOCAL_TIME: O horário informado não existe no fuso de origem\./);
  assert.equal(record.target_entity_id, null, 'nada foi gravado no destino');
});

test('m9d908 hora ambígua segue a regra FIRST_OCCURRENCE', { skip: skip() }, async () => {
  const two = localToUtc('2018-02-17 23:30', SP);
  assert.deepEqual([two.status, two.first, two.second], ['AMBIGUOUS', '2018-02-18T01:30:00.000Z', '2018-02-18T02:30:00.000Z']);
  const first = await migrate({ qa908At: '2018-02-17 23:30' });
  assert.equal(first.state, 'MIGRATED', 'padrão FIRST_OCCURRENCE');
  assert.equal(first.source_payload.qa908At, '2018-02-18T01:30:00.000Z');
  await env.setParam(A, 'migracao.fuso.ambiguo', 'SECOND_OCCURRENCE');
  assert.equal((await migrate({ qa908At: '2018-02-17 23:30' })).source_payload.qa908At, '2018-02-18T02:30:00.000Z');
  await env.setParam(A, 'migracao.fuso.ambiguo', 'QUARANTINE');
  const q = await migrate({ qa908At: '2018-02-17 23:30' });
  assert.equal(q.state, 'QUARANTINED');
  assert.match(q.reason, /^GOV_MIG_TZ_AMBIGUOUS_LOCAL_TIME:/);
});

test('m9d908 horário com fuso explícito vale o instante e o fuso de origem é o parâmetro', { skip: skip() }, async () => {
  assert.equal((await migrate({ qa908At: '2018-11-04T00:30:00-03:00' })).source_payload.qa908At, '2018-11-04T03:30:00.000Z', 'com deslocamento não passa pelo fuso de origem');
  assert.equal((await migrate({ qa908At: '2026-10-31 09:15:00' })).source_payload.qa908At, '2026-10-31T12:15:00.000Z', 'Brasília UTC-3');
  await env.setParam(A, 'migracao.fuso_origem', 'America/New_York');
  assert.equal((await migrate({ qa908At: '2026-10-31 09:15:00' })).source_payload.qa908At, '2026-10-31T13:15:00.000Z', 'Nova York em horário de verão UTC-4');
  assert.equal((await migrate({ qa908At: '2018-11-04 00:30' })).state, 'MIGRATED', 'a mesma hora existe em Nova York');
  assert.equal((await migrate({ qa908At: 'amanhã' })).state, 'QUARANTINED');
});

test('m9d908 data pura não muda de dia', { skip: skip() }, async () => {
  assert.equal(civilDay('2026-10-31 00:00:00'), '2026-10-31');
  assert.equal(civilDay('2026-10-31T00:00:00'), '2026-10-31');
  assert.equal(civilDay('2026-10-31'), '2026-10-31');
  assert.equal(civilDay(new Date(2026, 9, 31)), '2026-10-31', 'data do conector em meia-noite local continua 31');
  const record = await migrate({ birthDate: '2026-10-31 00:00:00' });
  assert.equal(record.state, 'MIGRATED');
  assert.equal(record.source_payload.birthDate, '2026-10-31');
  const [person] = (await env.adminQuery("SELECT to_char(birth_or_foundation_date, 'YYYY-MM-DD') AS d FROM people.persons WHERE id = $1", [record.target_entity_id])).rows;
  assert.equal(person.d, '2026-10-31', 'o destino guarda 31/10, nunca 30/10');
  for (const edge of ['2024-02-29', '2025-12-31', '2026-01-01']) {
    const r = await migrate({ birthDate: `${edge} 23:59:59` });
    assert.equal((await env.adminQuery("SELECT to_char(birth_or_foundation_date, 'YYYY-MM-DD') AS d FROM people.persons WHERE id = $1", [r.target_entity_id])).rows[0].d, edge);
  }
});

test('m9d908 o conversor usa a base IANA: horário de verão até 2019 e depois fixo', { skip: skip() }, async () => {
  assert.equal(localToUtc('2018-12-15 12:00', SP).utc, '2018-12-15T14:00:00.000Z', 'verão: UTC-2');
  assert.equal(localToUtc('2018-07-15 12:00', SP).utc, '2018-07-15T15:00:00.000Z', 'inverno: UTC-3');
  assert.equal(localToUtc('2026-12-15 12:00', SP).utc, '2026-12-15T15:00:00.000Z', 'sem horário de verão desde 2019');
  assert.equal(localToUtc('2019-02-30 10:00', SP).status, 'INVALID');
  assert.equal(localToUtc('2026-10-31', SP).status, 'INVALID', 'sem hora não é timestamp');
});
