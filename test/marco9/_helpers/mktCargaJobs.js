'use strict';

// Apoio dos testes de carga do worker de publicação (M9-D441, não é teste): N conteúdos institucionais aprovados e agendados no SITE (um job por conteúdo, COMMIT real), contagem das
// chamadas ao canal por chave de idempotência, instâncias do worker e limpeza. Só com DISPOSABLE_DB=1 e DATABASE_ADMIN_URL.
const { withTenantTransaction } = require('../../testHelpers');
const env = require('./mktWorker');
const carga = require('./mktCarga');

/** Cria `n` conteúdos aprovados e agendados no `canal`; devolve { itemIds, jobIds, when, now }. */
async function semear(ctx, n, { canal = 'SITE', paralelo = 4 } = {}) {
  const when = env.inMinutes(120);
  const tx = (fn) => withTenantTransaction(ctx.tenant, fn);
  const um = (i) => tx(async (t) => {
    const item = await env.pendingInstitutional(t, ctx, `QA-M9 carga ${i}`);
    await env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId: item.itemId, input: {} }, t);
    const scheduled = await env.schedule(t, ctx, item.itemId, { channels: [canal], when: when.toISOString() });
    return { itemId: item.itemId, jobId: scheduled.jobs[0].id };
  });
  // o primeiro agendamento cria a conexão do canal: os demais só começam depois dele (a criação simultânea da mesma conexão é conflito)
  const primeiro = await um(0);
  const demais = await carga.limited(Array.from({ length: n - 1 }, (_, i) => i + 1), paralelo, um);
  const linhas = [primeiro, ...demais];
  return { itemIds: linhas.map((l) => l.itemId), jobIds: linhas.map((l) => l.jobId), when, now: new Date(when.getTime() + 60000) };
}

/**
 * Troca o sandbox do canal por um que conta cada chamada de envio (chave de idempotência e instante). `antes(chave, n)` roda no início de cada envio (para acionar o kill switch ou
 * "derrubar" um worker no meio do lote). Devolve { chamadas, restaurar }.
 */
function espiar(canal, antes) {
  const chamadas = [];
  const restaurar = env.overrideSandbox(canal, (adapter) => {
    const original = adapter.execute.bind(adapter);
    adapter.execute = async (operation, payload, options) => {
      const registro = { chave: options.idempotencyKey, em: Date.now(), operation };
      chamadas.push(registro);
      if (antes) await antes(registro.chave, chamadas.length);
      return original(operation, payload, options);
    };
    return adapter;
  });
  return { chamadas, restaurar };
}

/**
 * Uma instância do worker: repete ciclos até `parar()` ou até `ociosos` ciclos seguidos sem pegar job. `agora()` devolve o relógio simulado do ciclo. `tx` é a fábrica de transações
 * (a instância "caída" passa uma que falha). Devolve o total de jobs pegos.
 */
async function instancia(ctx, { tx, agora, parar = () => false, ociosos = 2, maxCiclos = 400 }) {
  let pegos = 0; let semJob = 0;
  for (let i = 0; i < maxCiclos && !parar(); i += 1) {
    const r = await env.runWorkerCycle(ctx.tenant, { withTx: tx, now: agora() });
    pegos += r.claimed;
    semJob = r.claimed === 0 ? semJob + 1 : 0;
    if (semJob >= ociosos) break;
  }
  return pegos;
}

/** Apaga os conteúdos, versões, jobs, resultados e despachos de teste pelo id do item. */
async function limpar(itemIds) {
  if (!itemIds.length) return;
  await carga.withAdmin(async (admin) => {
    const versions = 'SELECT id FROM marketing.content_versions WHERE content_item_id = ANY($1::uuid[])';
    const jobs = `SELECT id FROM marketing.publication_jobs WHERE content_version_id IN (${versions})`;
    await admin.query(`DELETE FROM marketing.publication_results WHERE job_id IN (${jobs})`, [itemIds]);
    await admin.query('DELETE FROM integration.dispatches WHERE aggregate_id = ANY($1::uuid[])', [itemIds]);
    await admin.query(`DELETE FROM integration.outbox_events WHERE aggregate_id IN (${jobs}) OR aggregate_id = ANY($1::uuid[])`, [itemIds]);
    await admin.query(`DELETE FROM marketing.publication_jobs WHERE content_version_id IN (${versions})`, [itemIds]);
    await admin.query('UPDATE marketing.content_items SET current_version_id = NULL WHERE id = ANY($1::uuid[])', [itemIds]);
    await admin.query(`DELETE FROM marketing.content_versions WHERE content_item_id = ANY($1::uuid[])`, [itemIds]);
    await admin.query('DELETE FROM marketing.content_items WHERE id = ANY($1::uuid[])', [itemIds]);
  });
}

module.exports = { semear, espiar, instancia, limpar };
