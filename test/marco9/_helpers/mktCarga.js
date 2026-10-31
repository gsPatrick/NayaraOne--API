'use strict';

// Apoio dos testes de carga do Marketing (M9-D441): dados COMMITADOS em lote, concorrência limitada e limpeza pelo superusuário do banco descartável. Só roda com DISPOSABLE_DB=1 e
// DATABASE_ADMIN_URL (as transações concorrentes COMMITAM). Não é teste.
const { Client } = require('pg');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (as transações concorrentes COMMITAM)';

/** Executa fn(item, índice) para todos os itens com no máximo `limite` ao mesmo tempo; devolve os resultados na ordem. */
async function limited(items, limite, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next; next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, worker));
  return out;
}

/** Conexão de administração (ignora RLS e gatilhos de FK): só para montar e apagar volume. `fn(admin)` roda e a conexão é fechada. */
async function withAdmin(fn) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('SET session_replication_role = replica');
    return await fn(admin);
  } finally { await admin.end(); }
}

/** Apaga as pessoas de teste e tudo o que o Marketing e o CRM penduraram nelas. `personIds` = array de uuid. */
async function cleanupPeople(admin, personIds) {
  if (!personIds.length) return;
  const runs = 'SELECT id FROM marketing.automation_runs WHERE subject_id = ANY($1::uuid[])';
  await admin.query(`DELETE FROM integration.outbox_events WHERE aggregate_id IN (${runs}) OR aggregate_id = ANY($1::uuid[])`, [personIds]);
  await admin.query(`DELETE FROM marketing.automation_action_receipts WHERE run_id IN (${runs})`, [personIds]);
  await admin.query('DELETE FROM marketing.automation_runs WHERE subject_id = ANY($1::uuid[])', [personIds]);
  await admin.query('DELETE FROM core.tasks WHERE related_entity_id = ANY($1::uuid[])', [personIds]);
  await admin.query('DELETE FROM marketing.suppression_list WHERE person_id = ANY($1::uuid[])', [personIds]);
  await admin.query('DELETE FROM crm.messages WHERE person_id = ANY($1::uuid[])', [personIds]);
  await admin.query('DELETE FROM people.communication_consents WHERE person_id = ANY($1::uuid[])', [personIds]);
  await admin.query('DELETE FROM people.person_contacts WHERE person_id = ANY($1::uuid[])', [personIds]);
  await admin.query('DELETE FROM people.persons WHERE id = ANY($1::uuid[])', [personIds]);
}

/** Apaga o fluxo, as versões e as linhas do inbox do consumidor do runner para os eventos informados. */
async function cleanupFlow(admin, { flowId, templateId, eventIds = [] }) {
  if (eventIds.length) await admin.query("DELETE FROM integration.integration_inbox WHERE consumer_name = 'marketing.automation.runner' AND event_id::text = ANY($1::text[])", [eventIds.map(String)]).catch(() => null);
  await admin.query('UPDATE marketing.automation_flows SET published_version_id = NULL WHERE id = $1', [flowId]);
  await admin.query('DELETE FROM marketing.automation_versions WHERE flow_id = $1', [flowId]);
  await admin.query('DELETE FROM marketing.automation_flows WHERE id = $1', [flowId]);
  if (templateId) await admin.query('DELETE FROM marketing.templates WHERE id = $1', [templateId]);
}

module.exports = { DISPOSABLE, SKIP, limited, withAdmin, cleanupPeople, cleanupFlow };
