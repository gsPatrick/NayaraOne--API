'use strict';

/**
 * M9-D699 (reabertura M-4) — sonda de bloqueios, a prova DETERMINÍSTICA de que o BI não degrada o fluxo operacional: durante a janela com BI,
 * uma conexão administrativa olha pg_stat_activity a cada `intervalMs` e conta os backends do fluxo operacional (ou de qualquer outra sessão)
 * esperando um lock que uma sessão do BI segura (pg_blocking_pids). A pilha de BI se identifica no banco pelo application_name
 * `BI_APP_NAME` (PGAPPNAME do processo filho). O esperado é ZERO bloqueios causados pelo BI, em qualquer máquina e qualquer carga: o BI só lê.
 * A sonda também conta quantas amostras viram sessão do BI ativa (`biSeen`): zero significaria que o BI nem rodou e a prova não vale.
 */
const BI_APP_NAME = 'm9d699-bi';

const SQL = `
  SELECT
    count(*) FILTER (WHERE w.wait_event_type = 'Lock' AND EXISTS (
      SELECT 1 FROM unnest(pg_blocking_pids(w.pid)) AS b(pid) JOIN pg_stat_activity a ON a.pid = b.pid WHERE a.application_name = :app))::int AS blocked_by_bi,
    count(*) FILTER (WHERE w.application_name = :app AND w.state <> 'idle')::int AS bi_active
  FROM pg_stat_activity w WHERE w.datname = current_database()`;

/** admin: instância Sequelize administrativa. Devolve { start(), stop() => resumo }. */
function createLockProbe(admin, { intervalMs = 25 } = {}) {
  let timer = null;
  let running = false;
  const total = { samples: 0, blockedByBi: 0, biSeen: 0, maxBiActive: 0 };
  async function sample() {
    if (!running) return;
    try {
      const [[r]] = await admin.query(SQL, { replacements: { app: BI_APP_NAME } });
      total.samples += 1;
      total.blockedByBi += r.blocked_by_bi;
      if (r.bi_active > 0) total.biSeen += 1;
      total.maxBiActive = Math.max(total.maxBiActive, r.bi_active);
    } catch (err) {
      total.error = String(err.code || err.message);
    }
    if (running) timer = setTimeout(sample, intervalMs);
  }
  return {
    start() { running = true; timer = setTimeout(sample, 0); },
    async stop() { running = false; clearTimeout(timer); await new Promise((resolve) => { setTimeout(resolve, intervalMs + 5); }); return { ...total, intervalMs }; },
  };
}

/** Soma os resumos das janelas com BI. */
function mergeProbes(list) {
  return list.reduce((acc, p) => ({
    samples: acc.samples + p.samples, blockedByBi: acc.blockedByBi + p.blockedByBi, biSeen: acc.biSeen + p.biSeen, maxBiActive: Math.max(acc.maxBiActive, p.maxBiActive),
    intervalMs: p.intervalMs, ...(p.error ? { error: p.error } : acc.error ? { error: acc.error } : {}),
  }), { samples: 0, blockedByBi: 0, biSeen: 0, maxBiActive: 0, intervalMs: 0 });
}

module.exports = { createLockProbe, mergeProbes, BI_APP_NAME };
