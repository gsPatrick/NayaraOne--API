'use strict';

// DI-BI2-9 (verificação dos outros indicadores com o mesmo padrão de tec.queues_dlq) — as quatro filas de decisão do Centro de Comando (M9-D709) recebiam o instante da
// leitura (`asOfInstant`, o relógio de agora) como entrada da fórmula e, portanto, do hash do cálculo: cada passada da agenda (15 minutos) gravava revisão nova do valor
// e das dimensões sem que nada tivesse mudado. Agora o hash leva o efeito do instante (itens em aberto e envelhecidos), não o relógio. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('./marco9/_helpers/m9d709Env');
require('../src/features/analytics');

let env;
const at = (minutes) => new Date(e.bi.NOW.getTime() + minutes * 60000);
const setClock = (d) => e.bi.clock.setClock(() => d);

async function revisions(t, code, dimension = '') {
  const [rows] = await env.admin.query(
    `SELECT s.revision_no, s.value_numeric::text AS value, COALESCE(c.confirmations, 0) AS confirmations FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
       LEFT JOIN analytics.metric_snapshot_confirmations c ON c.snapshot_id = s.id
      WHERE s.company_id = :c AND d.metric_code = :code AND s.dimension_key = :dim AND s.as_of_date = :asOf ORDER BY s.revision_no`,
    { replacements: { c: t.companyId, code, dim: dimension, asOf: e.bi.AS_OF } }
  );
  return rows;
}

before(async () => {
  env = await e.setup();
  setClock(at(0));
});
after(async () => {
  await env.admin.query('DELETE FROM analytics.metric_snapshot_confirmations WHERE company_id IN (:ids)', { replacements: { ids: [env.cX.companyId, env.cY.companyId] } });
  await e.teardown(env);
});

test('DI-BI2-9 fila de decisão sem mudança: recálculos ao longo do dia só confirmam; o item que passa do limite de horas grava a revisão (efeito do instante)', async () => {
  const t = env.cX;
  const id = await e.finApproval(env, t, { amount: '50.00', hours: 47 }); // limite padrão: 48 horas
  await e.applyKind(t, 'FIN_APPROVAL', id);
  await e.materialize(t);
  for (const minutes of [15, 30, 45]) {
    setClock(at(minutes));
    await e.materialize(t);
  }
  let main = await revisions(t, 'fin.approvals_pending');
  assert.equal(main.length, 1, `três passadas sem mudança: nenhuma revisão nova (antes: uma por passada; vieram ${main.length})`);
  assert.equal(Number(main[0].confirmations), 3);
  assert.equal((await revisions(t, 'fin.approvals_pending', 'envelhecidas_qtd')).length, 1);

  setClock(at(125)); // 47 h + 2 h 05: o pedido passou do limite de 48 horas (horas inteiras: 49)
  await e.materialize(t);
  main = await revisions(t, 'fin.approvals_pending');
  assert.equal(main.length, 2, 'o envelhecimento muda o retrato: uma revisão');
  const aged = await revisions(t, 'fin.approvals_pending', 'envelhecidas_qtd');
  assert.deepEqual(aged.map((r) => Number(r.value)), [0, 1]);
  setClock(at(140));
  await e.materialize(t);
  assert.equal((await revisions(t, 'fin.approvals_pending')).length, 2, 'e volta a só confirmar');
});
