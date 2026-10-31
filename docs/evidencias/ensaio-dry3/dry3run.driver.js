'use strict';
// Ensaio DRY3 em banco descartável com origem sintética. Uso (dentro de withDisposableDb): node dry3run.js <cenario> <N> <saida.json>
process.chdir('/Users/patrick.developer/Desktop/Developer/Projects/Nayara/NayaraOne/NayaraOne--API');
const fs = require('node:fs');
const API = '/Users/patrick.developer/Desktop/Developer/Projects/Nayara/NayaraOne/NayaraOne--API';
const env = require(`${API}/test/marco9/_helpers/m9d908Dry`);
const load = require(`${API}/src/features/migration-v2/dryrun/dry.load`);
const [cenario, nStr, saida] = process.argv.slice(2);
const N = Number(nStr);
process.env.MIGRATION_DRY3_REPORT_PATH = saida;

function cpf(i) { // CPF valido deterministico e unico por indice
  const d = String(100000000 + i).padStart(9, '0').split('').map(Number);
  for (const len of [9, 10]) { let s = 0; for (let k = 0; k < len; k++) s += d[k] * (len + 1 - k); const r = (s * 10) % 11; d.push(r === 10 ? 0 : r); }
  return d.join('');
}
// datas de borda (date puro) e instantes de borda (fuso America/Sao_Paulo)
const BIRTHS = ['1992-02-29', '1999-12-31 23:59:59', '2000-01-01 00:00:00', '1985-04-12', '2026-10-31 00:00:00', '2000-02-29', '2024-02-29', '2018-11-03 23:59:59'];
const INSTANTS_OK = ['2018-11-03 23:59:59', '2018-11-04 01:00:00', '2018-02-17 23:30:00' /* ambigua: FIRST_OCCURRENCE */, '2018-02-18 00:00:00', '2019-02-16 23:59:59', '2026-10-31 00:00:00', '2026-12-31 23:59:59', '2024-02-29 12:00:00', '2017-10-15 01:00:00'];
const INSTANTS_BAD = ['2018-11-04 00:30:00' /* inexistente */];

(async () => {
  const t0 = Date.now();
  const A = (await env.loadTenants()).A;
  await env.cleanup(A);
  await env.isolate(A);
  await env.completeRaci(A);
  if (!process.env.NOINSTANT) await env.addInstantField(A, 'qa908At');
  const legacy = await env.installSource(A, { mode: 'WATERMARK', entity: 'PERSON' });
  const t = (i) => new Date(Date.UTC(2030, 0, 1, 0, 0, 0) + i * 1000);
  const rec = (i, extra = {}) => ({ legalName: `Cliente Sintetico ${i}`, personType: 'PF', taxId: cpf(i), birthDate: BIRTHS[i % BIRTHS.length], preferredName: `Apelido ${i}`, qa908At: INSTANTS_OK[i % INSTANTS_OK.length], ...extra });
  const t1 = Date.now();
  for (let i = 0; i < N; i++) legacy.fake.row(`k${i}`, t(i), rec(i));
  const conflitos = { invalidCpf: 0, duplicateCpf: 0, nonexistentTime: 0 };
  if (cenario === 'conflitos') {
    legacy.fake.row('bad-cpf', t(N + 1), rec(N + 1, { taxId: '123' })); conflitos.invalidCpf++;
    legacy.fake.row('dup-cpf', t(N + 2), rec(N + 2, { taxId: cpf(0) })); conflitos.duplicateCpf++;
    legacy.fake.row('bad-time', t(N + 3), rec(N + 3, { qa908At: INSTANTS_BAD[0] })); conflitos.nonexistentTime++;
  }
  // apagados e alteracoes na origem ENTRE a carga e o delta (gancho na fase LOAD)
  const apagados = process.env.NODEL ? 0 : Math.max(1, Math.floor(N / 100)); const alterados = cenario !== 'alterados' ? 0 : Math.max(1, Math.floor(N / 50));
  const orig = load.loadAll; let calls = 0;
  load.loadAll = async (...a) => {
    const r = await orig(...a); calls += 1;
    if (calls === 1) {
      for (let i = 0; i < apagados; i++) legacy.fake.drop(`k${i * 7 + 3}`);
      for (let i = 0; i < alterados; i++) legacy.fake.row(`k${i * 11 + 5}`, new Date(Date.UTC(2031, 0, 1, 0, 0, i)), rec(i * 11 + 5, { legalName: `Cliente Alterado ${i}` }));
    }
    return r;
  };
  const geracaoMs = Date.now() - t1;
  const report = await env.runDry3(A);
  load.loadAll = orig;
  const out = { cenario, N, apagadosNaOrigem: apagados, alteradosNaOrigem: alterados, conflitos, geracaoOrigemMs: geracaoMs, totalMs: Date.now() - t0, status: report.status, conclusion: report.conclusion, criteria: report.criteria, phases: report.phases, volumes: report.volumes, blockers: report.blockers, errors: report.errors, quarantine: report.quarantine, reportId: report.id, commit: report.commit };
  fs.writeFileSync(saida + '.relatorio-completo.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ cenario, N, status: out.status, conclusion: out.conclusion, totalMs: out.totalMs, phases: out.phases.map(p => [p.name, p.status, p.durationMs]), volumes: out.volumes, criteria: Object.fromEntries(Object.entries(out.criteria).map(([k, v]) => [k, v.ok])), errors: out.errors, blockers: out.blockers, quarantine: out.quarantine }, null, 1));
  out.motivos = (await env.adminQuery("SELECT state, reason, count(*)::int n FROM governance.mig_records WHERE company_id=$1 AND state IN ('QUARANTINED','PENDING_REVIEW') GROUP BY 1,2", [A.companyId])).rows; out.lotes = (await env.adminQuery("SELECT status, count(*)::int n FROM governance.mig_batches WHERE company_id=$1 GROUP BY 1", [A.companyId])).rows; console.log(JSON.stringify({motivos: out.motivos, lotes: out.lotes}));
  out.lotesPorExecucao = (await env.adminQuery("SELECT r.last_delta, b.status, b.source_count, count(*)::int n FROM governance.mig_batches b JOIN governance.mig_runs r ON r.id=b.run_id WHERE b.company_id=$1 GROUP BY 1,2,3 ORDER BY 1,2,3", [A.companyId])).rows; console.log(JSON.stringify({lotesPorExecucao: out.lotesPorExecucao}));
  if (process.env.DBG) { const r = await env.adminQuery("SELECT r.source_key, r.state, r.source_payload->>'legalName' AS src, p.legal_name AS dst, p.preferred_name pn, r.source_payload->>'preferredName' spn, p.birth_or_foundation_date::text bd, r.source_payload->>'birthDate' sbd FROM governance.mig_records r LEFT JOIN people.persons p ON p.id=r.target_entity_id WHERE r.company_id=$1 AND r.state='QUARANTINED' LIMIT 3", [A.companyId]); console.log(JSON.stringify(r.rows)); }
  fs.writeFileSync(saida + '.relatorio-completo.json', JSON.stringify(out, null, 2));
  await env.sequelize.close();
})().catch((e) => { console.error('FALHA DO SCRIPT', e); process.exit(1); });
