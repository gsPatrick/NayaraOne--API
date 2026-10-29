'use strict';

/**
 * Drill (d) do livro: o outbox está parado (o worker não roda). Os runs completam normalmente, cada um deixa exatamente um evento ai.run.completed
 * PENDING (nada se perde) e, quando o worker volta, os eventos saem uma vez só. Grava de verdade (precisa de banco descartável) e aposenta o agente ao fim.
 */
const agents = require('../../../src/features/ai/agents');
const { dispatchPendingEventsForCompany } = require('../../../src/engines/events/outbox-dispatcher');

const RUNS = 3;

function comoTenant(F, tenant, fn) {
  return F.sequelize.transaction(async (transaction) => {
    await F.sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await F.sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await F.sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    return fn(transaction);
  });
}

const eventosDe = (F, runIds, tx) => F.q(
  "SELECT aggregate_id, status, idempotency_key FROM integration.outbox_events WHERE event_type = 'ai.run.completed' AND aggregate_id = ANY(CAST(:ids AS uuid[])) ORDER BY occurred_at",
  { ids: `{${runIds.join(',')}}` }, tx
);

module.exports = {
  id: 'outbox-parado',
  letra: 'd',
  titulo: 'O outbox de eventos está parado',
  esperado: 'Os runs completam; cada run deixa um único evento ai.run.completed PENDING enquanto o worker está parado; ao voltar, cada evento é despachado uma vez só e nenhum se perde.',
  async executar({ F, tenantA, relatorio }) {
    let codigo = null;
    const runIds = [];
    try {
      await comoTenant(F, tenantA, async (tx) => {
        const c = await F.H.cenario(tenantA, tx);
        codigo = c.code;
        for (let i = 0; i < RUNS; i += 1) {
          const r = await F.H.rodar(c, `Classifique o pedido ${i} [[RESPOSTA:Tipo comercial ${i}.]]`, { taskType: 'classificar' });
          if (r.ok) runIds.push(r.runId);
        }
      });
      relatorio.confere(`os ${RUNS} runs completaram com o outbox parado`, runIds.length === RUNS, `${runIds.length} de ${RUNS}`);
      const parados = await comoTenant(F, tenantA, (tx) => eventosDe(F, runIds, tx));
      relatorio.confere('um evento ai.run.completed por run, nenhum perdido', parados.length === RUNS && new Set(parados.map((e) => e.aggregate_id)).size === RUNS, `${parados.length} eventos`);
      relatorio.confere('todos acumulados como PENDING (nada foi despachado)', parados.every((e) => e.status === 'PENDING'));
      relatorio.confere('chaves de idempotência únicas', new Set(parados.map((e) => e.idempotency_key)).size === RUNS);
      const run = await comoTenant(F, tenantA, (tx) => F.q('SELECT status FROM ai.ai_runs WHERE id = ANY(CAST(:ids AS uuid[]))', { ids: `{${runIds.join(',')}}` }, tx));
      relatorio.confere('nenhum run preso em RUNNING', run.length === RUNS && run.every((r) => r.status === 'COMPLETED'), run.map((r) => r.status).join(','));
      // O worker volta: despacha os eventos acumulados; uma segunda passada não despacha de novo.
      const grupo = { id: tenantA.groupId };
      const empresa = { id: tenantA.companyId };
      const primeira = await dispatchPendingEventsForCompany(grupo, empresa, { limit: 1000 });
      relatorio.confere('o worker despacha os eventos acumulados', primeira.dispatched >= RUNS, JSON.stringify(primeira));
      const depois = await comoTenant(F, tenantA, (tx) => eventosDe(F, runIds, tx));
      relatorio.confere('os eventos do drill ficam DISPATCHED', depois.length === RUNS && depois.every((e) => e.status === 'DISPATCHED'), depois.map((e) => e.status).join(','));
      const segunda = await dispatchPendingEventsForCompany(grupo, empresa, { limit: 1000 });
      const final = await comoTenant(F, tenantA, (tx) => eventosDe(F, runIds, tx));
      relatorio.confere('uma segunda passada não despacha de novo (exatamente uma vez)', final.length === RUNS && final.every((e) => e.status === 'DISPATCHED') && segunda.dispatched >= 0);
    } finally {
      if (codigo) await comoTenant(F, tenantA, (tx) => agents.retire({ groupId: tenantA.groupId, companyId: tenantA.companyId, userId: tenantA.userId }, codigo, 1, tx)).catch(() => null);
    }
  },
};
