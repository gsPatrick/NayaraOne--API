'use strict';

/**
 * M9-D699 (3.2) — uma janela de medição. O fluxo operacional (OLTP) roda no processo pai com N usuários simulados em laço fechado; quando a
 * janela tem BI, a pilha de BI (processo filho, biWorker.js) abre os painéis ao mesmo tempo e, num instante configurado da janela, dispara o
 * rebuild do FinanceHealthReadModel de uma empresa que não recebe escrita (o rebuild lê as fontes do OLTP, §19). Devolve as amostras por rótulo.
 */
const { createRecorder } = require('./stats');
const { createOps, OP_NAMES } = require('./oltpOps');
const { createLockProbe } = require('./lockProbe');
const { startCpuMeter } = require('./hostCpu');

function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Falha esperada do negócio não existe neste fluxo: qualquer exceção é falha inesperada. */
async function oltpUser(index, ctx, rec, deadline) {
  const rnd = prng(ctx.rndSeed + index);
  const ops = createOps({ sequelize: ctx.sequelize, seed: ctx.seed, sizes: ctx.sizes, rnd });
  const tenant = ctx.oltpTenants[index % ctx.oltpTenants.length];
  let i = index;
  while (Date.now() < deadline) {
    const name = OP_NAMES[i % OP_NAMES.length];
    i += 1;
    const t0 = process.hrtime.bigint();
    try {
      await ops[name](tenant);
      rec.record(name, Number(process.hrtime.bigint() - t0) / 1e6, true);
    } catch (err) {
      rec.record(name, Number(process.hrtime.bigint() - t0) / 1e6, false, String(err.code || err.name || 'ERRO'));
    }
    if (ctx.thinkMs > 0) await new Promise((resolve) => { setTimeout(resolve, ctx.thinkMs); });
  }
}

function askChild(child, message, expected) {
  return new Promise((resolve, reject) => {
    const onMessage = (msg) => {
      if (msg.type === 'error') { child.off('message', onMessage); reject(new Error(msg.message)); }
      if (msg.type === expected) { child.off('message', onMessage); resolve(msg); }
    };
    child.on('message', onMessage);
    child.send(message);
  });
}

/**
 * ctx: { sequelize, seed, sizes, rndSeed, oltpTenants, thinkMs, child, biConfig, rebuild: async () => resumo }
 * options: { durationMs, oltpUsers, biUsers, withBi, rebuildAtMs }
 */
async function runWindow(ctx, { durationMs, oltpUsers, withBi, rebuildAtMs, noRebuild = false, windowIndex = 0, windowCount = 1 }) {
  const rec = createRecorder();
  const stopCpu = startCpuMeter();
  const deadline = Date.now() + durationMs;
  const probe = withBi && ctx.admin ? createLockProbe(ctx.admin, { intervalMs: ctx.lockSampleMs }) : null;
  if (probe && !noRebuild) probe.start();
  const jobs = Array.from({ length: oltpUsers }, (_, i) => oltpUser(i, ctx, rec, deadline));
  let rebuild = null;
  let bi = Promise.resolve({ raw: {} });
  bi = askChild(ctx.child, { cmd: 'run', config: { ...ctx.biConfig, durationMs, users: ctx.biConfig.users, neutral: !withBi, windowIndex, windowCount } }, 'done'); // sem BI roda a carga neutra (sem banco)
  if (withBi) {
    if (ctx.rebuild && !noRebuild) {
      jobs.push(new Promise((resolve) => { setTimeout(resolve, rebuildAtMs); }).then(async () => {
        const t0 = Date.now();
        try {
          rebuild = { ...(await ctx.rebuild()), completed: true, durationMs: Date.now() - t0 };
        } catch (err) {
          rebuild = { completed: false, error: `${err.code || 'ERRO'}: ${err.message}`, durationMs: Date.now() - t0 };
        }
      }));
    }
  }
  await Promise.all(jobs);
  const biDone = await bi;
  const locks = probe && !noRebuild ? await probe.stop() : null;
  return { oltp: rec.raw(), bi: biDone.raw, rebuild, locks, cpuBusy: stopCpu() };
}

module.exports = { runWindow, askChild, prng };
