'use strict';

/**
 * Carga do diário de obra (Guia M6 §13 "load/failure tests", sprint O9 "carga"; Caderno §2 "Diário registra obra/data/turno...;
 * correção não apaga original", §6 "Chave lógica project_id + work_date + shift_code", §12 "Diário duplicado → idempotência/revisão").
 * Volume real pelos serviços (role de runtime, RLS real, transações commitadas), gravações em paralelo, tempo medido por gravação
 * e por leitura (p95). Volumes, paralelismo e limites vêm de scripts/ci-obras/parametros.json (nada fixo aqui); a meta de leitura
 * é a do contrato §16 ("p95 < 300ms em consultas comuns"). Só em banco descartável (DISPOSABLE_DB=1) ou no CI.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers/obrasCarga');
const projectHealthService = require('../src/features/construction/projectHealth.service');

const P = H.parametros();
const DIA_ZERO = Date.UTC(2026, 0, 5);
const dataDoDia = (d) => new Date(DIA_ZERO + d * 86400000).toISOString().slice(0, 10);
let tenant;
before(async () => { if (H.podeRodar) tenant = await H.getSeedTenant(); });
after(async () => { await H.sequelize.close(); });

/** Executa as tarefas com no máximo `paralelas` ao mesmo tempo; devolve [{ ok, ms, erro }] na ordem. */
async function emParalelo(tarefas, paralelas) {
  const saida = new Array(tarefas.length);
  let proxima = 0;
  async function trabalhador() {
    while (proxima < tarefas.length) {
      const i = proxima;
      proxima += 1;
      const t0 = process.hrtime.bigint();
      try {
        await tarefas[i]();
        saida[i] = { ok: true, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
      } catch (erro) {
        saida[i] = { ok: false, ms: Number(process.hrtime.bigint() - t0) / 1e6, erro };
      }
    }
  }
  await Promise.all(H.intervalo(paralelas).map(trabalhador));
  return saida;
}

const novoRdo = (dia, extras = {}) => H.W(tenant, {
  reportDate: dataDoDia(dia), shiftCode: 'MANHA', workforceCount: 6 + (dia % 5), servicesPerformed: `Serviços do dia ${dia}`,
  materials: [{ materialDescription: 'Cimento CP-II', quantity: 10 + dia, unit: 'SC' }], idempotencyKey: `o9-carga-${crypto.randomUUID()}`, ...extras,
});

test(`Carga do diário: ${P.diarioObras} obras × ${P.diarioDiasPorObra} dias com ${P.diarioGravacoesParalelas} gravações em paralelo — nenhum RDO perdido ou trocado de obra, um evento por RDO, p95 de gravação e de leitura dentro do limite`, { skip: H.motivoPular, timeout: P.limiteRajadaMs * 30 }, async () => {
  const obras = [];
  for (const i of H.intervalo(P.diarioObras)) obras.push((await H.comCommit(tenant, (t) => H.obraComEtapa(tenant, t, `carga diário ${i}`))).project);
  const tarefas = obras.flatMap((obra) => H.intervalo(P.diarioDiasPorObra).map((dia) => () => H.comCommit(tenant, (t) => H.svc('dailyReports').createDailyReport(obra.id, novoRdo(dia), tenant.userId, t))));
  const gravacoes = await emParalelo(tarefas, P.diarioGravacoesParalelas);
  const erros = gravacoes.filter((g) => !g.ok).map((g) => g.erro.code || g.erro.message);
  assert.deepEqual(erros, [], 'toda gravação do volume passa');
  const p95Gravacao = H.percentil(gravacoes.map((g) => g.ms), 95);
  console.log(`# carga do diário: ${gravacoes.length} RDOs, p50 ${H.percentil(gravacoes.map((g) => g.ms), 50).toFixed(1)} ms, p95 ${p95Gravacao.toFixed(1)} ms, máx ${Math.max(...gravacoes.map((g) => g.ms)).toFixed(1)} ms (limite p95 ${P.limiteP95GravacaoRdoMs} ms)`);
  assert.ok(p95Gravacao <= P.limiteP95GravacaoRdoMs, `p95 da gravação ${p95Gravacao.toFixed(1)} ms acima de ${P.limiteP95GravacaoRdoMs} ms`);

  const ids = obras.map((o) => o.id);
  const porObra = await H.linhaAdmin(`SELECT r.project_id AS obra, count(*)::int AS rdos, count(DISTINCT r.report_date)::int AS dias,
      (SELECT count(*) FROM construction.daily_materials m JOIN construction.daily_reports r2 ON r2.id = m.daily_report_id WHERE r2.project_id = r.project_id)::int AS materiais
    FROM construction.daily_reports r WHERE r.project_id = ANY($1::uuid[]) GROUP BY r.project_id`, [ids]);
  assert.equal(porObra.length, P.diarioObras);
  for (const linha of porObra) assert.deepEqual({ rdos: linha.rdos, dias: linha.dias, materiais: linha.materiais }, { rdos: P.diarioDiasPorObra, dias: P.diarioDiasPorObra, materiais: P.diarioDiasPorObra }, `obra ${linha.obra}`);
  const [{ n: eventos }] = await H.linhaAdmin("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'project.daily_log.created' AND (payload_json->>'projectId')::uuid = ANY($1::uuid[])", [ids]);
  assert.equal(eventos, P.diarioObras * P.diarioDiasPorObra, 'um project.daily_log.created por RDO');

  const leiturasDiario = [];
  const leiturasSaude = [];
  for (const i of H.intervalo(P.leiturasRepetidas)) {
    const obra = obras[i % obras.length];
    let t0 = process.hrtime.bigint();
    const lista = await H.comCommit(tenant, (t) => H.svc('dailyReports').listDailyReports(obra.id, t, { pageSize: P.diarioDiasPorObra }));
    leiturasDiario.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(lista.pagination.total, P.diarioDiasPorObra);
    t0 = process.hrtime.bigint();
    await H.comCommit(tenant, (t) => projectHealthService.getProjectHealth(obra.id, t));
    leiturasSaude.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const p95Diario = H.percentil(leiturasDiario, 95);
  const p95Saude = H.percentil(leiturasSaude, 95);
  console.log(`# leitura: lista do diário p95 ${p95Diario.toFixed(1)} ms; Saúde da obra p95 ${p95Saude.toFixed(1)} ms (${P.leiturasRepetidas} leituras cada; limite ${P.limiteP95LeituraMs} ms)`);
  assert.ok(p95Diario <= P.limiteP95LeituraMs, `lista do diário p95 ${p95Diario.toFixed(1)} ms`);
  assert.ok(p95Saude <= P.limiteP95LeituraMs, `Saúde da obra p95 ${p95Saude.toFixed(1)} ms`);
});

test(`Carga do diário: ${P.diarioReenviosSimultaneos} reenvios simultâneos do MESMO RDO (mesma chave) devolvem o mesmo registro — um RDO e um evento`, { skip: H.motivoPular }, async () => {
  const { project } = await H.comCommit(tenant, (t) => H.obraComEtapa(tenant, t, 'reenvio do diário'));
  const rdo = novoRdo(0);
  const r = await Promise.allSettled(H.intervalo(P.diarioReenviosSimultaneos).map(() => H.comCommit(tenant, (t) => H.svc('dailyReports').createDailyReport(project.id, rdo, tenant.userId, t))));
  const falhas = r.filter((x) => x.status === 'rejected').map((x) => x.reason.code || x.reason.message);
  assert.deepEqual(falhas, [], 'reenvio com a mesma chave é idempotente, não erro');
  assert.equal(new Set(r.map((x) => x.value.id)).size, 1, 'todos receberam o mesmo RDO');
  const [linha] = await H.linhaAdmin(`SELECT (SELECT count(*) FROM construction.daily_reports WHERE project_id = $1)::int AS rdos,
    (SELECT count(*) FROM integration.outbox_events WHERE event_type = 'project.daily_log.created' AND payload_json->>'projectId' = $1::text)::int AS eventos`, [project.id]);
  assert.deepEqual(linha, { rdos: 1, eventos: 1 });
});

test(`Carga do diário: ${P.diarioReenviosSimultaneos} gravações simultâneas da MESMA obra/data/turno com chaves diferentes — um RDO, as demais recusadas como duplicado`, { skip: H.motivoPular }, async () => {
  const { project } = await H.comCommit(tenant, (t) => H.obraComEtapa(tenant, t, 'duplicado do diário'));
  const r = await Promise.allSettled(H.intervalo(P.diarioReenviosSimultaneos).map(() => H.comCommit(tenant, (t) => H.svc('dailyReports').createDailyReport(project.id, novoRdo(1), tenant.userId, t))));
  const ok = r.filter((x) => x.status === 'fulfilled');
  const recusas = r.filter((x) => x.status === 'rejected');
  assert.equal(ok.length, 1, 'só um RDO por obra/data/turno');
  assert.ok(recusas.every((x) => x.reason.code === 'DAILY_REPORT_DUPLICATE' || H.codigoPg(x.reason) === '23505'), recusas.map((x) => x.reason.code || x.reason.message).join(', '));
  const [linha] = await H.linhaAdmin('SELECT count(*)::int AS rdos FROM construction.daily_reports WHERE project_id = $1', [project.id]);
  assert.equal(linha.rdos, 1);
});
