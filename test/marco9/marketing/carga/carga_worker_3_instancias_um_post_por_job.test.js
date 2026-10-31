'use strict';

// M9-D441 carga (b): o worker de publicação com 3 instâncias simultâneas processa 1.000 jobs e cada job é processado uma só vez (um post por job). Conta as chamadas reais ao canal por chave de
// idempotência, o resultado de sucesso por job e as tentativas. 1.000 é só o tamanho do conjunto para forçar concorrência, não uma meta de desempenho. COMMIT real: só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withTenantTransaction } = require('../../../testHelpers');
const env = require('../../_helpers/mktWorker');
const carga = require('../../_helpers/mktCarga');
const jobs = require('../../_helpers/mktCargaJobs');

const TOTAL = 1000;
let ctx; let itemIds = [];
before(async () => { if (carga.DISPOSABLE) ctx = await env.setup(); });
after(async () => { if (carga.DISPOSABLE) { env.resetSandbox(); await jobs.limpar(itemIds); } await sequelize.close(); });

test('carga_worker_3_instancias_um_post_por_job', { skip: carga.SKIP }, async (tctx) => {
  env.resetSandbox();
  const inicio = Date.now();
  const semeado = await jobs.semear(ctx, TOTAL);
  itemIds = semeado.itemIds;
  const tSemear = Date.now() - inicio;
  const tx = (fn) => withTenantTransaction(ctx.tenant, fn);
  const { chamadas, restaurar } = jobs.espiar('SITE');
  let pegos;
  const t0 = Date.now();
  try {
    pegos = await Promise.all([1, 2, 3].map(() => jobs.instancia(ctx, { tx, agora: () => semeado.now })));
  } finally { restaurar(); }
  const tWorker = Date.now() - t0;

  // cada job foi pego por uma só instância, uma só vez
  assert.equal(pegos.reduce((a, b) => a + b, 0), TOTAL, `jobs pegos pelas 3 instâncias: ${pegos}`);
  assert.ok(pegos.filter((n) => n > 0).length >= 2, `a carga foi dividida entre as instâncias: ${pegos}`);
  // um post por job: nenhuma chave de idempotência foi enviada duas vezes, e todas as chaves são de jobs deste teste
  const porChave = new Map();
  for (const c of chamadas) porChave.set(c.chave, (porChave.get(c.chave) || 0) + 1);
  assert.equal(porChave.size, TOTAL, 'uma chave de idempotência por job');
  assert.deepEqual([...porChave.values()].filter((n) => n !== 1), [], 'nenhuma chave enviada duas vezes (MKT_LOAD_INVARIANT_BROKEN)');
  assert.equal(chamadas.length, TOTAL, 'chamadas ao canal = jobs');
  // estado final: todos PUBLISHED com uma tentativa e exatamente um resultado de sucesso
  const [resumo] = await tx((t) => env.fx.q(t, `SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'PUBLISHED' AND attempts = 1)::int AS ok,
      (SELECT count(*)::int FROM (SELECT job_id FROM marketing.publication_results WHERE outcome = 'SUCCESS' AND job_id = ANY(:ids::uuid[]) GROUP BY job_id HAVING count(*) = 1) x) AS sucesso_unico
    FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[]))`, { ids: `{${semeado.jobIds.join(',')}}` }));
  assert.deepEqual(resumo, { n: TOTAL, ok: TOTAL, sucesso_unico: TOTAL });
  tctx.diagnostic(`${TOTAL} jobs, 3 instâncias (${pegos.join(' + ')}): ${chamadas.length} chamadas ao canal, ${porChave.size} chaves distintas, 0 repetidas, ${resumo.ok} PUBLISHED com 1 tentativa e 1 resultado de sucesso; semear ${tSemear} ms, worker ${tWorker} ms`);
});
