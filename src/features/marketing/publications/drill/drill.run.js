'use strict';

const adapters = require('../adapters');
const { DRILL_SCENARIOS, BASELINE_SCENARIO } = require('./drill.constants');
const { pickTenant, withDrillTransaction } = require('./drill.env');
const { casesFor } = require('./drill.cases');
const R = require('./drill.report');
const { recordChannelResult } = require('./drill.record');

/** Roda UM caso na transação descartável da empresa; exceção vira reprovação com o motivo (o ensaio nunca para no meio). */
async function runCase(picked, channel, fn) {
  const env = { tenant: picked.tenant, reviewer: picked.reviewer, channel };
  try {
    const out = await withDrillTransaction(picked.tenant, (t) => fn(t, env));
    return { ok: out.ok, obtained: out.obtained };
  } catch (err) {
    return { ok: false, obtained: `exceção ${err && err.code ? `${err.code} ` : ''}${err && err.message ? String(err.message).slice(0, 200) : err}` };
  } finally {
    adapters.resetSandbox();
  }
}

/**
 * Failure drill de provedor (M9-D442): para cada canal pedido roda o caso de base e os 12 cenários do livro, cada um numa transação descartável, e monta o relatório
 * (canal, cenário, esperado, obtido, aprovado). `register`: grava o resultado de cada canal como evidência FAILURE_DRILL do releaseChannel. Não lança em divergência: o veredito
 * está em `report.passed` (use assertPassed para virar MKT_DRILL_FAILED). `onRow` é chamado a cada linha, para o script mostrar o andamento.
 */
async function runDrill({ channels = adapters.CHANNELS, companyId = null, register = false, onRow = () => {}, now = new Date() } = {}) {
  const picked = await pickTenant(companyId);
  if (!picked) throw new Error('Nenhuma empresa com ao menos duas pessoas para o ensaio.');
  const report = R.newReport(now);
  for (const channel of channels) {
    const { baseline, cases } = casesFor(channel);
    const base = await runCase(picked, channel, baseline);
    report.baseline.push(R.row(channel, BASELINE_SCENARIO, 'Uma publicação sai uma vez e fecha como publicada.', base.ok, base.obtained));
    onRow(report.baseline[report.baseline.length - 1]);
    for (const scenario of DRILL_SCENARIOS) {
      const out = await runCase(picked, channel, cases[scenario.id]);
      report.rows.push(R.row(channel, scenario.id, scenario.expected, out.ok, out.obtained));
      onRow(report.rows[report.rows.length - 1]);
    }
  }
  const finished = R.finish(report, new Date());
  const recorded = [];
  if (register) for (const channel of channels) recorded.push(await recordChannelResult(picked.tenant, channel, finished));
  return { report: finished, recorded, tenant: picked.tenant };
}

module.exports = { runDrill, runCase };
