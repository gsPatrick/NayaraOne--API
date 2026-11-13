'use strict';

/**
 * Concorrência de Obras (Guia M6 §13 etapa "concurrency"; Caderno §2 "evento repetido não pode criar segunda obrigação",
 * §12 "Medição duplicada → uma obrigação", "measurement.approved repetido → uma conta a pagar", "Updates concorrentes").
 * Rajadas REAIS: cada chamada na sua conexão e transação commitada, disparadas juntas. Tamanho das rajadas e tempo máximo vêm
 * de scripts/ci-obras/parametros.json (nada fixo aqui). Só em banco descartável (DISPOSABLE_DB=1) ou no CI.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/obrasCarga');
const receiptService = require('../src/modules/finance/application/services/receipt.service');

const P = H.parametros();
let tenant;
before(async () => { if (H.podeRodar) tenant = await H.getSeedTenant(); });
after(async () => { await H.sequelize.close(); });

async function rajada(fns) {
  const t0 = Date.now();
  const resultados = await Promise.allSettled(fns.map((fn) => fn()));
  return { resultados, ms: Date.now() - t0, ok: resultados.filter((r) => r.status === 'fulfilled'), falhas: resultados.filter((r) => r.status === 'rejected') };
}

test(`Concorrência: ${P.aprovacoesSimultaneas} aprovações simultâneas da MESMA medição geram uma só conta a pagar e um só measurement.approved`, { skip: H.motivoPular }, async () => {
  const fx = await H.medicaoRevisada(tenant, 'aprovação concorrente', 12345.67);
  const r = await rajada(H.intervalo(P.aprovacoesSimultaneas).map(() => () => H.comCommit(tenant, (t) => H.aprovar(tenant, fx.measurementId, t))));
  assert.equal(r.ok.length, 1, 'só UMA aprovação vence');
  assert.equal(r.falhas.length, P.aprovacoesSimultaneas - 1);
  assert.ok(r.falhas.every((f) => f.reason.code === 'STAGE_MEASUREMENT_INVALID_STATUS'), r.falhas.map((f) => f.reason.code || f.reason.message).join(', '));
  assert.ok(r.ms <= P.limiteRajadaMs, `a rajada terminou em ${r.ms} ms (limite ${P.limiteRajadaMs})`);
  const [med] = await H.linhaAdmin('SELECT status, total_amount::numeric AS t, payable_financial_entry_id AS p FROM construction.stage_measurements WHERE id = $1', [fx.measurementId]);
  assert.equal(med.status, 'PAYABLE');
  const contas = await H.linhaAdmin('SELECT id, amount::numeric AS v, nature, status FROM finance.financial_entries WHERE idempotency_key = $1', [`measurement.payable:${fx.measurementId}`]);
  assert.equal(contas.length, 1, 'uma só conta a pagar');
  assert.equal(contas[0].id, med.p);
  assert.equal(Number(contas[0].v), Number(med.t));
  assert.equal(contas[0].nature, 'PAYABLE');
  const [{ n }] = await H.linhaAdmin("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'measurement.approved' AND aggregate_id = $1", [fx.measurementId]);
  assert.equal(n, 1, 'um só evento measurement.approved');
});

test(`Concorrência: ${P.aprovacoesSimultaneas} medições DIFERENTES (obras distintas da mesma empresa) aprovadas ao mesmo tempo — cada uma com a sua conta, nenhuma perdida`, { skip: H.motivoPular }, async () => {
  const fxs = [];
  for (const i of H.intervalo(P.aprovacoesSimultaneas)) fxs.push(await H.medicaoRevisada(tenant, `paralela ${i}`, 1000 + i));
  const r = await rajada(fxs.map((fx) => () => H.comCommit(tenant, (t) => H.aprovar(tenant, fx.measurementId, t))));
  assert.equal(r.ok.length, fxs.length, r.falhas.map((f) => f.reason.code || f.reason.message).join(', '));
  const ids = fxs.map((fx) => fx.measurementId);
  const contas = await H.linhaAdmin("SELECT idempotency_key AS k, amount::numeric AS v FROM finance.financial_entries WHERE idempotency_key = ANY($1::text[])", [ids.map((id) => `measurement.payable:${id}`)]);
  assert.equal(contas.length, fxs.length, 'uma conta por medição');
  assert.equal(new Set(contas.map((c) => c.k)).size, fxs.length);
  const soma = contas.reduce((acc, c) => acc + Number(c.v), 0);
  const esperado = H.intervalo(fxs.length).reduce((acc, i) => acc + 1000 + i, 0);
  assert.equal(Math.round(soma * 100), Math.round(esperado * 100), 'a soma das contas é a soma das medições, centavo a centavo');
});

test(`Concorrência na baixa: ${P.baixasIntegraisSimultaneas} baixas integrais simultâneas da conta da medição — só uma vale, um só evento e uma só auditoria`, { skip: H.motivoPular }, async () => {
  const fx = await H.contaDaMedicaoProntaParaBaixa(tenant, 'baixa integral concorrente', 8765.43);
  const r = await rajada(H.intervalo(P.baixasIntegraisSimultaneas).map(() => () => H.comCommit(tenant, (t) => receiptService.settleFinancialEntry(fx.entryId, tenant.userId, t, { manualSettlement: fx.manualSettlement }))));
  assert.equal(r.ok.length, 1, `só UMA baixa vence (${r.falhas.map((f) => f.reason.code || f.reason.message).join(', ')})`);
  assert.ok(r.falhas.every((f) => f.reason.code === 'FINANCE_ENTRY_INVALID_STATUS'), r.falhas.map((f) => f.reason.code || f.reason.message).join(', '));
  assert.ok(r.ms <= P.limiteRajadaMs, `a rajada terminou em ${r.ms} ms (limite ${P.limiteRajadaMs})`);
  const [conta] = await H.linhaAdmin('SELECT status, amount::numeric AS v FROM finance.financial_entries WHERE id = $1', [fx.entryId]);
  assert.equal(conta.status, 'SETTLED');
  const [{ n: eventos }] = await H.linhaAdmin("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'finance.entry.settled' AND aggregate_id = $1", [fx.entryId]);
  assert.equal(eventos, 1, 'um só finance.entry.settled');
  const [{ n: auditorias }] = await H.linhaAdmin("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'finance.entry.settle' AND entity_id = $1", [fx.entryId]);
  assert.equal(auditorias, 1, 'uma só linha de auditoria da baixa');
  const [{ n: filhas }] = await H.linhaAdmin('SELECT count(*)::int AS n FROM finance.financial_entries WHERE parent_entry_id = $1', [fx.entryId]);
  assert.equal(filhas, 0, 'baixa integral não cria parcela');
});

async function rajadaDeParcelas() {
  const total = 10000;
  const fx = await H.contaDaMedicaoProntaParaBaixa(tenant, 'baixa parcial concorrente', total);
  const parcela = Math.round((total / P.baixasParciaisSimultaneas) * 100) / 100;
  const r = await rajada(H.intervalo(P.baixasParciaisSimultaneas + 1).map((i) => () => H.comCommit(tenant, (t) => receiptService.settleFinancialEntryPartial(
    fx.entryId, parcela, tenant.userId, t, { manualSettlement: fx.manualSettlement, idempotencyKey: `o9-parcela-${fx.entryId}-${i}` },
  ))));
  return { fx, total, parcela, r };
}

test(`Concorrência na baixa: ${P.baixasParciaisSimultaneas} parcelas iguais + 1 excedente ao mesmo tempo — a soma paga nunca passa do total`, { skip: H.motivoPular }, async () => {
  const { fx, total, r } = await rajadaDeParcelas();
  const [pai] = await H.linhaAdmin('SELECT status FROM finance.financial_entries WHERE id = $1', [fx.entryId]);
  const filhas = await H.linhaAdmin("SELECT amount::numeric AS v FROM finance.financial_entries WHERE parent_entry_id = $1 AND status = 'SETTLED'", [fx.entryId]);
  const pago = filhas.reduce((acc, f) => acc + Number(f.v), 0);
  assert.ok(Math.round(pago * 100) <= total * 100, `pago ${pago} não pode passar do total ${total}`);
  assert.equal(r.ok.length, P.baixasParciaisSimultaneas, `${P.baixasParciaisSimultaneas} parcelas valem (${r.falhas.map((f) => f.reason.code || f.reason.message).join(', ')})`);
  assert.equal(r.falhas.length, 1, 'a parcela excedente é recusada');
  assert.equal(Math.round(pago * 100), total * 100, 'o total foi pago exatamente');
  assert.equal(pai.status, 'SETTLED');
});

test('Concorrência na baixa: cada parcela paga carrega a obra (construction_project_id) — relatório por obra não perde pagamento parcial', {
  skip: H.motivoPular,
}, async () => {
  const { fx } = await rajadaDeParcelas();
  const filhas = await H.linhaAdmin("SELECT construction_project_id AS obra FROM finance.financial_entries WHERE parent_entry_id = $1 AND status = 'SETTLED'", [fx.entryId]);
  assert.ok(filhas.length > 0);
  assert.ok(filhas.every((f) => f.obra === fx.projectId), JSON.stringify(filhas));
});
