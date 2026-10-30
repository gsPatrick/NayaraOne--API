'use strict';

// M9-D401 — schema marketing parte 2 (append-only, redação, imutabilidade e CHECKs). Roda com nayara_runtime (RLS real) em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('../src/models');
const {
  base, expectDbError, mkAutoVersion, mkFlow, mkJob, mkRun, mkVersion, prepararTenants, q, sha, uid,
} = require('./helpers/marketingExecucao');
const { withRollbackTenantTransaction } = require('./testHelpers');

let tenantA;
let tenantB;

before(async () => {
  ({ tenantA, tenantB } = await prepararTenants());
});

after(async () => {
  await sequelize.close();
});

test('publication_results_e_append_only', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const jobId = await mkJob(tenantA, tx);
    const [{ id }] = await q(`INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome, occurred_at)
      VALUES (:g, :c, :j, 1, 'FAILURE', now()) RETURNING id`, { ...base(tenantA), j: jobId }, tx);
    const e1 = await expectDbError(tx, "UPDATE marketing.publication_results SET outcome = 'SUCCESS' WHERE id = :id", { id }, /MKT_RESULT_APPEND_ONLY/);
    assert.equal(e1.parent.code, 'MK002');
    await expectDbError(tx, 'DELETE FROM marketing.publication_results WHERE id = :id', { id }, /MKT_RESULT_APPEND_ONLY|permission/i);
    await expectDbError(tx, `INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome) VALUES (:g, :c, :j, 2, 'TALVEZ')`,
      { ...base(tenantA), j: jobId }, /outcome/i);
    await expectDbError(tx, `INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome) VALUES (:g, :c, :j, 0, 'SUCCESS')`,
      { ...base(tenantA), j: jobId }, /attempt/i);
  });
});

test('response_redacted_nao_guarda_segredo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const jobId = await mkJob(tenantA, tx);
    const payload = {
      Authorization: 'Bearer abc.def.ghi', status: 'ok', max_tokens: 100,
      headers: { 'Set-Cookie': 'sid=1', 'content-type': 'application/json', 'X-Api-Key': 'k-123' },
      data: { access_token: 'EAAB123', refresh_token: 'r', client_secret: 's', password: 'p', nested: [{ apiKey: 'zzz' }, { id: 'post-1' }] },
      note: 'Bearer sk-live-xyz',
    };
    const [{ r }] = await q(`INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome, response_redacted_json)
      VALUES (:g, :c, :j, 1, 'SUCCESS', CAST(:p AS jsonb)) RETURNING response_redacted_json AS r`, { ...base(tenantA), j: jobId, p: JSON.stringify(payload) }, tx);
    const txt = JSON.stringify(r);
    for (const segredo of ['abc.def.ghi', 'sid=1', 'k-123', 'EAAB123', 'sk-live-xyz', 'zzz']) assert.ok(!txt.includes(segredo), `vazou ${segredo}`);
    assert.equal(r.Authorization, '[REDIGIDO]');
    assert.equal(r.headers['Set-Cookie'], '[REDIGIDO]');
    assert.equal(r.headers['X-Api-Key'], '[REDIGIDO]');
    assert.equal(r.data.access_token, '[REDIGIDO]');
    assert.equal(r.data.nested[0].apiKey, '[REDIGIDO]');
    assert.equal(r.note, '[REDIGIDO]');
    // O que não é segredo permanece.
    assert.equal(r.status, 'ok');
    assert.equal(r.max_tokens, 100);
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.data.nested[1].id, 'post-1');
  });
});

test('versao_publicada_de_automacao_e_imutavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const flow = await mkFlow(tenantA, tx);
    const draft = await mkAutoVersion(tenantA, tx, flow, 'DRAFT', 1);
    // Rascunho é editável.
    await q(`UPDATE marketing.automation_versions SET actions = '[{"action_key":"a2"}]'::jsonb WHERE id = :id`, { id: draft }, tx);
    await q("UPDATE marketing.automation_versions SET status = 'PUBLISHED' WHERE id = :id", { id: draft }, tx);
    for (const set of ["actions = '[]'::jsonb", "conditions = '[1]'::jsonb", "trigger_config = '{}'::jsonb", "cooldown = '{\"d\":1}'::jsonb",
      "frequency_cap = '{\"n\":1}'::jsonb", `content_hash = '${sha('outro')}'`, "risk_level = 'HIGH'", "valid_until = now()"]) {
      const err = await expectDbError(tx, `UPDATE marketing.automation_versions SET ${set} WHERE id = :id`, { id: draft }, /MKT_AUTOMATION_VERSION_IMMUTABLE/);
      assert.equal(err.parent.code, 'MK003');
    }
    await expectDbError(tx, "UPDATE marketing.automation_versions SET status = 'DRAFT' WHERE id = :id", { id: draft }, /MKT_AUTOMATION_VERSION_IMMUTABLE/);
    // A transição de estado continua permitida.
    await q("UPDATE marketing.automation_versions SET status = 'PAUSED' WHERE id = :id", { id: draft }, tx);
    await q("UPDATE marketing.automation_versions SET status = 'PUBLISHED' WHERE id = :id", { id: draft }, tx);
    await q("UPDATE marketing.automation_versions SET status = 'SUPERSEDED' WHERE id = :id", { id: draft }, tx);
    await expectDbError(tx, "UPDATE marketing.automation_versions SET actions = '[]'::jsonb WHERE id = :id", { id: draft }, /MKT_AUTOMATION_VERSION_IMMUTABLE/);
    // version_no único por fluxo.
    await expectDbError(tx, `INSERT INTO marketing.automation_versions (group_id, company_id, flow_id, version_no, trigger_type, actions, status, risk_level, content_hash)
      VALUES (:g, :c, :f, 1, 'EVENT', '[]'::jsonb, 'DRAFT', 'LOW', :h)`, { ...base(tenantA), f: flow, h: sha('x') }, /version/i);
    // O fluxo aponta para a versão publicada.
    await q('UPDATE marketing.automation_flows SET published_version_id = :v WHERE id = :f', { v: draft, f: flow }, tx);
  });
});

test('check_de_status_da_run_aceita_waiting_e_recusa_outro', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ver = await mkAutoVersion(tenantA, tx, await mkFlow(tenantA, tx));
    for (const st of ['STARTED', 'COMPLETED', 'BLOCKED', 'FAILED']) await mkRun(tenantA, tx, ver, { status: st });
    const due = '2026-11-02T11:00:00Z';
    const acoes = [
      { action_key: 'a1', status: 'SCHEDULED', due_at: due, provider_ref: null, error_code: null },
      { action_key: 'a2', status: 'PENDING', due_at: null },
    ];
    const waiting = await mkRun(tenantA, tx, ver, { status: 'WAITING', due, actionsResult: acoes });
    await q(`UPDATE marketing.automation_runs SET policy_trace = '[{"passo":"consent","ok":true}]'::jsonb WHERE id = :id`, { id: waiting }, tx);
    const [lida] = await q('SELECT status, next_due_at, policy_trace FROM marketing.automation_runs WHERE id = :id', { id: waiting }, tx);
    assert.equal(lida.status, 'WAITING');
    assert.ok(lida.next_due_at);
    assert.equal(lida.policy_trace[0].passo, 'consent');
    const ins = (status, due2, ar) => ({ sql: `INSERT INTO marketing.automation_runs (group_id, company_id, automation_version_id, correlation_id, idempotency_key, status, next_due_at, actions_result)
      VALUES (:g, :c, :v, :cid, :k, :st, :due, CAST(:ar AS jsonb))`, rep: { ...base(tenantA), v: ver, cid: uid(), k: `run:${uid()}`, st: status, due: due2, ar: JSON.stringify(ar) } });
    for (const bad of ['WAIT', 'PAUSED', 'DONE', 'waiting']) {
      const { sql, rep } = ins(bad, null, []);
      await expectDbError(tx, sql, rep, /status/i);
    }
    // WAITING exige next_due_at.
    { const { sql, rep } = ins('WAITING', null, acoes); await expectDbError(tx, sql, rep, /next_due|waiting/i); }
    // Status de ação fora do enum e formato fora de lista.
    { const { sql, rep } = ins('STARTED', null, [{ action_key: 'a1', status: 'OTHER' }]); await expectDbError(tx, sql, rep, /actions_result/i); }
    { const { sql, rep } = ins('STARTED', null, [{ status: 'OK' }]); await expectDbError(tx, sql, rep, /actions_result/i); }
    { const { sql, rep } = ins('STARTED', null, { action_key: 'a1', status: 'OK' }); await expectDbError(tx, sql, rep, /actions_result/i); }
    for (const s of ['PENDING', 'SCHEDULED', 'OK', 'SKIPPED', 'FAILED', 'UNKNOWN']) {
      const { sql, rep } = ins('STARTED', null, [{ action_key: 'k', status: s }]);
      await q(sql, rep, tx);
    }
    // Índice parcial da agenda.
    const [idx] = await q("SELECT indexdef FROM pg_indexes WHERE schemaname = 'marketing' AND tablename = 'automation_runs' AND indexdef ILIKE '%next_due_at%'");
    assert.match(idx.indexdef, /WAITING/);
  });
});

test('checks_de_rastreio_atribuicao_e_avaliacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [p] = await q('SELECT id FROM people.persons LIMIT 1', {}, tx);
    // tracking_links
    const tl = (over) => ({ ...base(tenantA), s: uid().slice(0, 10), u: 'https://exemplo.test/x', ch: 'SITE', sig: sha('s'), st: 'ACTIVE', ...over });
    const tlSql = `INSERT INTO marketing.tracking_links (group_id, company_id, short_code, target_url, channel, signature, status) VALUES (:g, :c, :s, :u, :ch, :sig, :st)`;
    const codigo = uid().slice(0, 10);
    await q(tlSql, tl({ s: codigo }), tx);
    await expectDbError(tx, tlSql, tl({ s: codigo }), /short_code/i);
    await expectDbError(tx, tlSql, tl({ st: 'X' }), /status/i);
    await expectDbError(tx, tlSql, tl({ u: 'javascript:alert(1)' }), /target_url|url/i);
    await expectDbError(tx, tlSql, tl({ ch: 'SMS' }), /channel/i);
    // short_code é único GLOBAL: outra empresa também não pode repetir (o erro vem do banco, mesmo sem ver a linha).
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: tx });
    await expectDbError(tx, tlSql, tl({ ...base(tenantB), s: codigo }), /short_code/i);
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction: tx });

    // attribution_events
    const ae = (over) => ({ ...base(tenantA), et: 'CLICK', p: null, tr: '{}', ev: '{"k":1}', ...over });
    const aeSql = `INSERT INTO marketing.attribution_events (group_id, company_id, person_id, event_type, touch_roles, evidence_json, occurred_at)
      VALUES (:g, :c, :p, :et, CAST(:tr AS text[]), CAST(:ev AS jsonb), now())`;
    await q(aeSql, ae(), tx); // CLICK anônimo
    await q(aeSql, ae({ tr: '{FIRST,LAST}' }), tx);
    await expectDbError(tx, aeSql, ae({ et: 'SALE' }), /person/i);
    await expectDbError(tx, aeSql, ae({ et: 'LEAD_CREATED' }), /person/i);
    await expectDbError(tx, aeSql, ae({ et: 'ORDER' }), /event_type/i);
    await expectDbError(tx, aeSql, ae({ tr: '{MIDDLE}' }), /touch_roles/i);
    await expectDbError(tx, aeSql, ae({ ev: null }), /evidence_json/i);
    if (p) await q(aeSql, ae({ et: 'SALE', p: p.id, tr: '{LAST}' }), tx);

    // review_requests
    if (p) {
      const rr = (over) => ({ ...base(tenantA), p: p.id, s: uid(), st: 'PENDING', ch: 'EMAIL', sc: null, pr: null, ...over });
      const rrSql = `INSERT INTO marketing.review_requests (group_id, company_id, person_id, source_entity_type, source_entity_id, status, channel, satisfaction_score, public_rating)
        VALUES (:g, :c, :p, 'CONTRACT', :s, :st, :ch, :sc, :pr)`;
      await q(rrSql, rr({ sc: 5, pr: 1 }), tx);
      await expectDbError(tx, rrSql, rr({ sc: 0 }), /satisfaction/i);
      await expectDbError(tx, rrSql, rr({ sc: 6 }), /satisfaction/i);
      await expectDbError(tx, rrSql, rr({ pr: 6 }), /public_rating/i);
      await expectDbError(tx, rrSql, rr({ st: 'OPEN' }), /status/i);
      for (const st of ['PENDING', 'BLOCKED_NEGATIVE', 'SENT', 'DELIVERED', 'COMPLETED', 'FAILED', 'SUPPRESSED']) await q(rrSql, rr({ st }), tx);
    }
  });
});

test('publication_jobs_status_e_conexao_na_mesma_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { versionId } = await mkVersion(tenantA, tx);
    const sql = `INSERT INTO marketing.publication_jobs (group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at, attempts)
      VALUES (:g, :c, :v, :ch, 'a', :st, :k, now(), :n)`;
    const r = (o) => ({ ...base(tenantA), v: versionId, ch: 'SITE', st: 'PENDING', k: `pub:${versionId}:SITE:${uid()}`, n: 0, ...o });
    const channels = ['SITE', 'EMAIL', 'PORTAL', 'TIKTOK', 'YOUTUBE', 'LINKEDIN']; // um job ativo por versão e canal (M9-D410): cada status em um canal
    for (const [i, st] of ['PENDING', 'RUNNING', 'PUBLISHED', 'FAILED', 'UNKNOWN', 'CANCELLED'].entries()) await q(sql, r({ st, ch: channels[i], k: `pub:${versionId}:${channels[i]}:${uid()}` }), tx);
    await expectDbError(tx, sql, r({ st: 'DONE' }), /status/i);
    await expectDbError(tx, sql, r({ ch: 'SMS' }), /channel/i);
    await expectDbError(tx, sql, r({ n: -1 }), /attempts/i);
    // Versão de outra empresa: a FK composta recusa.
    const outro = await sequelize.transaction(async (t2) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: t2 });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: t2 });
      return null;
    });
    assert.equal(outro, null);
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantB.groupId }, transaction: tx });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantB.companyId }, transaction: tx });
    await expectDbError(tx, sql, r({ ...base(tenantB) }), /content_version|foreign key/i);
  });
});

