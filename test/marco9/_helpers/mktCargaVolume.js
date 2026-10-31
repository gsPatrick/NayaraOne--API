'use strict';

// Volume para o teste do plano de execução do canSend (M9-D441, não é teste): pessoas, contatos, consentimentos, mensagens, supressões e execuções de automação em lote, montados pelo
// superusuário do banco descartável (sem gatilhos), todos marcados com o prefixo da carga para a limpeza. Só com DISPOSABLE_DB=1 e DATABASE_ADMIN_URL.
const PREFIX = 'QA-M9 carga';

/** Cria o volume na empresa `tenant`; devolve { personIds (amostra), contagens }. `n` = { pessoas, mensagens, supressoes, runs }. */
async function criarVolume(admin, tenant, versionId, n) {
  const g = tenant.groupId; const c = tenant.companyId;
  await admin.query(`CREATE TEMP TABLE qa_p AS SELECT gen_random_uuid() AS id, i FROM generate_series(1, $1::int) i`, [n.pessoas]);
  await admin.query(`INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) SELECT id, $1, $2, 'PF', $3 || ' ' || i, 'ACTIVE' FROM qa_p`, [g, c, PREFIX]);
  await admin.query(`INSERT INTO people.person_contacts (id, group_id, company_id, person_id, contact_type, value_normalized, is_primary)
    SELECT gen_random_uuid(), $1, $2, id, 'WHATSAPP', '55719' || lpad(i::text, 8, '0'), true FROM qa_p`, [g, c]);
  await admin.query(`INSERT INTO people.communication_consents (id, group_id, company_id, person_id, channel, purpose, status, recorded_at)
    SELECT gen_random_uuid(), $1, $2, id, 'WHATSAPP', 'MARKETING', 'OPT_IN', now() - interval '30 days' FROM qa_p`, [g, c]);
  await admin.query(`INSERT INTO crm.messages (id, group_id, company_id, person_id, channel, direction, author_type, status, purpose, action_key, created_at)
    SELECT gen_random_uuid(), $1, $2, p.id, CASE WHEN m % 5 = 0 THEN 'EMAIL' ELSE 'WHATSAPP' END, CASE WHEN m % 3 = 0 THEN 'INBOUND' ELSE 'OUTBOUND' END,
           CASE WHEN m % 3 = 0 THEN 'CLIENT' ELSE 'NAY' END, CASE WHEN m % 3 = 0 THEN 'RECEIVED' ELSE 'SENT' END, CASE WHEN m % 3 = 0 THEN NULL ELSE 'MARKETING' END,
           CASE WHEN m % 3 = 0 THEN NULL ELSE md5('qa-m9-carga-' || m) || md5('qa-m9-carga2-' || m) END, now() - (m % 90) * interval '1 day' - (m % 1440) * interval '1 minute'
      FROM generate_series(1, $3::int) m JOIN qa_p p ON p.i = 1 + (m % $4::int)`, [g, c, n.mensagens, n.pessoas]);
  await admin.query(`INSERT INTO marketing.suppression_list (id, group_id, company_id, address_hash, channel, reason, source, active)
    SELECT gen_random_uuid(), $1, $2, encode(sha256(('qa-m9-carga-sup-' || i)::bytea), 'hex'), CASE WHEN i % 2 = 0 THEN 'EMAIL' ELSE 'WHATSAPP' END, 'OPT_OUT', 'QA-M9-CARGA', true FROM generate_series(1, $3::int) i`, [g, c, n.supressoes]);
  await admin.query(`INSERT INTO marketing.automation_runs (id, group_id, company_id, automation_version_id, trigger_event_id, subject_type, subject_id, correlation_id, idempotency_key, status, actions_result)
    SELECT gen_random_uuid(), $1, $2, $3, 'evt-qa-carga', 'PERSON', p.id, gen_random_uuid(), 'run:qa-m9-carga-' || r, 'COMPLETED',
           jsonb_build_array(jsonb_build_object('action_key', md5('qa-m9-carga-run-' || r) || md5('x' || r), 'action_type', 'SEND_MESSAGE', 'status', 'OK', 'channel', 'WHATSAPP', 'purpose', 'MARKETING', 'at', (now() - (r % 30) * interval '1 day')::text))
      FROM generate_series(1, $4::int) r JOIN qa_p p ON p.i = 1 + (r % $5::int)`, [g, c, versionId, n.runs, n.pessoas]);
  await admin.query('ANALYZE people.persons'); await admin.query('ANALYZE people.person_contacts'); await admin.query('ANALYZE people.communication_consents');
  await admin.query('ANALYZE crm.messages'); await admin.query('ANALYZE marketing.suppression_list'); await admin.query('ANALYZE marketing.automation_runs');
  const amostra = (await admin.query('SELECT id FROM qa_p WHERE i IN (1, 2, 7, 1000, 4999) ORDER BY i')).rows.map((r) => r.id);
  return { amostra };
}

/** Uma execução WAITING com ação de envio reservada (PENDING, ainda sem mensagem) para cada pessoa: é o caso em que o canSend confere a reserva contra as mensagens. */
async function reservar(admin, tenant, versionId, personIds, at) {
  await admin.query(`INSERT INTO marketing.automation_runs (id, group_id, company_id, automation_version_id, trigger_event_id, subject_type, subject_id, correlation_id, idempotency_key, status, next_due_at, actions_result)
    SELECT gen_random_uuid(), $1, $2, $3, 'evt-qa-carga', 'PERSON', p, gen_random_uuid(), 'run:qa-m9-carga-reserva-' || p, 'WAITING', now() + interval '1 day',
           jsonb_build_array(jsonb_build_object('action_key', md5('qa-m9-carga-reserva-' || p) || md5('r' || p), 'action_type', 'SEND_MESSAGE', 'status', 'PENDING', 'channel', 'WHATSAPP', 'purpose', 'MARKETING', 'at', $5::text))
      FROM unnest($4::uuid[]) p`, [tenant.groupId, tenant.companyId, versionId, personIds, at.toISOString()]);
}

/** Apaga o volume (e o fluxo de apoio) pelo prefixo e pelas marcas das linhas. */
async function apagarVolume(admin, tenant, flowId) {
  const ids = `SELECT id FROM people.persons WHERE company_id = $1 AND legal_name LIKE '${PREFIX} %'`;
  await admin.query(`DELETE FROM crm.messages WHERE company_id = $1 AND person_id IN (${ids})`, [tenant.companyId]);
  await admin.query(`DELETE FROM marketing.automation_runs WHERE company_id = $1 AND trigger_event_id = 'evt-qa-carga'`, [tenant.companyId]);
  await admin.query("DELETE FROM marketing.suppression_list WHERE company_id = $1 AND source = 'QA-M9-CARGA'", [tenant.companyId]);
  await admin.query(`DELETE FROM people.communication_consents WHERE company_id = $1 AND person_id IN (${ids})`, [tenant.companyId]);
  await admin.query(`DELETE FROM people.person_contacts WHERE company_id = $1 AND person_id IN (${ids})`, [tenant.companyId]);
  await admin.query(`DELETE FROM people.persons WHERE company_id = $1 AND legal_name LIKE '${PREFIX} %'`, [tenant.companyId]);
  if (flowId) {
    await admin.query('UPDATE marketing.automation_flows SET published_version_id = NULL WHERE id = $1', [flowId]);
    await admin.query('DELETE FROM marketing.automation_versions WHERE flow_id = $1', [flowId]);
    await admin.query('DELETE FROM marketing.automation_flows WHERE id = $1', [flowId]);
  }
}

module.exports = { criarVolume, reservar, apagarVolume, PREFIX };
