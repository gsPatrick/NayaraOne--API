'use strict';

// M9-D441 carga (e): queda de um worker no meio do lote. A instância A pega um lote, publica alguns jobs, o canal ACEITA um post cujo resultado ela não chega a gravar e ela cai com o resto do
// lote em RUNNING. As instâncias B e C retomam: o RUNNING abandonado vira UNKNOWN, a reconciliação pergunta ao canal pela chave (achou: publicado, sem segundo post; ausente: volta a PENDING e
// sai uma vez). Zero perda, zero duplicidade. COMMIT real: só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withTenantTransaction } = require('../../../testHelpers');
const env = require('../../_helpers/mktWorker');
const carga = require('../../_helpers/mktCarga');
const jobs = require('../../_helpers/mktCargaJobs');
const isolamento = require('../../_helpers/mktCargaIsolamento');

const TOTAL = 100;
const CAI_NA_CHAMADA = 7;
let ctx; let iso; let itemIds = [];
before(async () => { if (carga.DISPOSABLE) { ctx = await env.setup(); iso = await isolamento.isolar(ctx.tenant.companyId, ['killswitch', 'jobs']); } });
after(async () => { if (carga.DISPOSABLE) { env.resetSandbox(); await jobs.limpar(itemIds); await iso.restaurar(); } await sequelize.close(); });

test('queda_de_worker_sem_perda_nem_duplicidade', { skip: carga.SKIP }, async (tctx) => {
  env.resetSandbox();
  const semeado = await jobs.semear(ctx, TOTAL);
  itemIds = semeado.itemIds;
  const tx = (fn) => withTenantTransaction(ctx.tenant, fn);
  let caiu = false;
  const txDeA = (fn) => (caiu ? Promise.reject(new Error('QA-M9: o processo do worker A caiu')) : tx(fn));
  // a chamada 7 chega ao canal (o post existe) e, antes de A gravar o resultado, A cai
  const { chamadas, restaurar } = jobs.espiar('SITE', async (chave, n) => { if (n === CAI_NA_CHAMADA) caiu = true; });
  try {
    await jobs.instancia(ctx, { tx: txDeA, agora: () => semeado.now }).catch(() => null); // A trabalha e cai
    assert.ok(caiu, 'o worker A caiu no meio do lote');
    const aposQueda = await tx((t) => env.fx.q(t, 'SELECT status, count(*)::int AS n FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[])) GROUP BY status', { ids: `{${semeado.jobIds.join(',')}}` }));
    const caido = Object.fromEntries(aposQueda.map((r) => [r.status, r.n]));
    assert.ok(caido.RUNNING > 1, `a queda deixou jobs em RUNNING: ${JSON.stringify(caido)}`);
    const postsAntes = chamadas.length;
    // B e C retomam com o relógio andando (a espera de cada retentativa e de cada reconciliação vem dos parâmetros do worker)
    let relogio = semeado.now.getTime() + 3600000;
    let rodadas = 0;
    const abertos = async () => (await tx((t) => env.fx.q(t, "SELECT count(*)::int AS n FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[])) AND status IN ('PENDING','RUNNING','UNKNOWN')", { ids: `{${semeado.jobIds.join(',')}}` })))[0].n;
    while (rodadas < 80 && await abertos() > 0) {
      relogio += 5 * 60000;
      const now = new Date(relogio);
      await Promise.all([1, 2].map(() => env.runWorkerCycle(ctx.tenant, { withTx: tx, now })));
      rodadas += 1;
    }
    assert.equal(await abertos(), 0, `os jobs retomados terminaram em ${rodadas} rodadas`);
    // zero perda: todo job PUBLISHED, nenhum FAILED; zero duplicidade: cada chave enviada uma só vez e um post por job no canal
    const porChave = new Map();
    for (const c of chamadas) porChave.set(c.chave, (porChave.get(c.chave) || 0) + 1);
    assert.equal(porChave.size, TOTAL, 'toda chave chegou ao canal');
    assert.deepEqual([...porChave.entries()].filter(([, n]) => n !== 1), [], 'MKT_LOAD_INVARIANT_BROKEN: chave enviada mais de uma vez');
    assert.equal(chamadas.length, TOTAL, 'envios ao canal = jobs');
    assert.equal(require('../../../../src/features/marketing/publications').adapters.sandboxRecordCount(ctx.tenant.companyId, 'SITE'), TOTAL, 'um post por job no canal');
    const estado = await tx((t) => env.fx.q(t, 'SELECT status, count(*)::int AS n FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[])) GROUP BY status', { ids: `{${semeado.jobIds.join(',')}}` }));
    assert.deepEqual(estado, [{ status: 'PUBLISHED', n: TOTAL }]);
    const sucessos = await tx((t) => env.fx.q(t, "SELECT count(*)::int AS n FROM (SELECT job_id FROM marketing.publication_results WHERE outcome IN ('SUCCESS', 'RECONCILED_FOUND') AND job_id = ANY(CAST(:ids AS uuid[])) GROUP BY job_id HAVING count(*) = 1) x", { ids: `{${semeado.jobIds.join(',')}}` }));
    assert.equal(sucessos[0].n, TOTAL, 'um único resultado positivo por job (SUCCESS, ou RECONCILED_FOUND quando o canal já tinha o post)');
    const achados = await tx((t) => env.fx.q(t, "SELECT count(*)::int AS n FROM marketing.publication_results WHERE outcome = 'RECONCILED_FOUND' AND job_id = ANY(CAST(:ids AS uuid[]))", { ids: `{${semeado.jobIds.join(',')}}` }));
    assert.ok(achados[0].n >= 1, 'o post aceito pelo canal antes da queda foi reconhecido pela reconciliação, sem segundo post');
    tctx.diagnostic(`worker A caiu na chamada ${CAI_NA_CHAMADA} de ${TOTAL} jobs (${JSON.stringify(caido)} após a queda, ${postsAntes} envios até lá); B e C retomaram em ${rodadas} rodadas (${achados[0].n} reconhecido(s) pela reconciliação): ${TOTAL} PUBLISHED, ${chamadas.length} envios ao canal, 0 chaves repetidas, 0 perdidos`);
  } finally { restaurar(); }
});
