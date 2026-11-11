'use strict';

/**
 * Verificação pós-restore de Obras (Marco 6). Compara ORIGEM × DESTINO e confere invariantes no
 * DESTINO restaurado:
 *   1. Toda tabela do schema `construction` + os reflexos fora dele (lançamentos financeiros da obra,
 *      movimentos de estoque da obra, eventos da Outbox de Obras, auditoria de Obras e as fotos das
 *      evidências): contagem e SHA-256 do conteúdo idênticos.
 *   2. Invariantes de negócio da obra do drill: baseline do orçamento, aditivo aprovado, medição PAYABLE
 *      com UMA conta a pagar, diário original preservado ao lado da correção, NC/garantia fechadas com
 *      evidências que existem em people.files, devolução do canteiro (RETURN) e estorno da perda.
 *   3. Segurança no destino: RLS ENABLE+FORCE em toda tabela de Obras; a role de runtime sem contexto de
 *      empresa não vê nada; com contexto vê a obra; e a UNIQUE da conta a pagar da medição continua
 *      valendo (reprocessar measurement.approved não cria segunda obrigação depois do restore).
 *
 * Uso: node scripts/restoreDrill/verifyConstructionRestore.js --source-url <super> --target-url <super>
 *        --target-app-url <runtime> --fixtures <fixtures.json> [--report <out.json>]
 * Exit 1 se qualquer verificação falhar.
 */

const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');

const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
const EVENTOS = ['project.created', 'project.budget.approved', 'project.started', 'project.stage.completed', 'project.daily_log.created',
  'measurement.submitted', 'measurement.approved', 'material.requested', 'material.received', 'nonconformity.opened', 'nonconformity.closed',
  'project.delivered', 'warranty.case.opened', 'warranty.case.closed'];

const results = [];
function check(name, ok, detail) {
  results.push({ verificacao: name, ok: Boolean(ok), detalhe: detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

async function connect(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function fingerprint(c, sql) {
  const { rows } = await c.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), 'vazio') AS h FROM (${sql}) x`);
  return { linhas: rows[0].n, sha256: crypto.createHash('sha256').update(rows[0].h).digest('hex') };
}

async function main() {
  const fx = JSON.parse(fs.readFileSync(arg('--fixtures'), 'utf8'));
  const src = await connect(arg('--source-url'));
  const dst = await connect(arg('--target-url'));
  try {
    console.log('1. Origem × destino (contagem + SHA-256 do conteúdo)');
    const { rows: tabelas } = await src.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'construction' AND table_type = 'BASE TABLE' ORDER BY 1");
    const alvos = tabelas.map((t) => [`construction.${t.table_name}`, `SELECT * FROM construction.${t.table_name}`]);
    alvos.push(['finance.financial_entries (da obra)', 'SELECT * FROM finance.financial_entries WHERE construction_project_id IS NOT NULL']);
    alvos.push(['inventory.inventory_movements (da obra)', 'SELECT * FROM inventory.inventory_movements WHERE project_id IS NOT NULL']);
    alvos.push(['integration.outbox_events (Obras)', `SELECT id, event_type, aggregate_id, idempotency_key, payload_json FROM integration.outbox_events WHERE event_type = ANY('{${EVENTOS.join(',')}}'::text[]) OR event_type LIKE 'construction.%'`]);
    alvos.push(['audit.audit_log (Obras)', "SELECT id, action, entity_type, entity_id, before_json, after_json FROM audit.audit_log WHERE action LIKE 'construction.%'"]);
    alvos.push(['people.files (evidências de Obras)', `SELECT id, file_name, checksum_sha256, size_bytes FROM people.files WHERE id IN (
      SELECT unnest(before_evidence_file_ids || after_evidence_file_ids) FROM construction.nonconformities
      UNION SELECT unnest(before_media_file_ids || after_media_file_ids) FROM construction.maintenance_cases
      UNION SELECT unnest(evidence_file_ids) FROM construction.daily_reports
      UNION SELECT unnest(evidence_file_ids) FROM construction.change_orders)`]);
    const comparacao = [];
    for (const [nome, sql] of alvos) {
      const a = await fingerprint(src, sql);
      const b = await fingerprint(dst, sql);
      comparacao.push({ tabela: nome, origem: a, destino: b });
      check(`${nome} idênticas`, a.linhas === b.linhas && a.sha256 === b.sha256, `${a.linhas} linhas na origem, ${b.linhas} no destino`);
    }

    console.log('2. Invariantes da obra do drill no destino');
    const one = async (sql, p) => (await dst.query(sql, p)).rows[0] || null;
    const proj = await one('SELECT status FROM construction.projects WHERE id = $1', [fx.projectId]);
    check('obra restaurada no estado WARRANTY (entregue, em garantia)', proj && proj.status === 'WARRANTY', proj);
    const bud = await one('SELECT status, baseline_amount::numeric AS b FROM construction.budgets WHERE id = $1', [fx.budgetId]);
    const co = await one('SELECT status, budget_impact::numeric AS i FROM construction.change_orders WHERE id = $1', [fx.changeOrderId]);
    check('baseline = valor congelado na aprovação + aditivo aprovado', bud && bud.status === 'APPROVED' && co && co.status === 'APPROVED'
      && Number(bud.b) === fx.baselineAtApproval + Number(co.i), { baseline: bud && Number(bud.b), aprovacao: fx.baselineAtApproval, aditivo: co && Number(co.i) });
    const med = await one('SELECT status, total_amount::numeric AS t, payable_financial_entry_id AS p FROM construction.stage_measurements WHERE id = $1', [fx.measurementId]);
    const pay = await one("SELECT count(*)::int AS n, min(amount)::numeric AS v FROM finance.financial_entries WHERE idempotency_key = $1", [`measurement.payable:${fx.measurementId}`]);
    check('medição PAYABLE com exatamente uma conta a pagar do mesmo valor', med && med.status === 'PAYABLE' && med.p === fx.payableId && Number(med.t) === fx.measurementTotal && pay.n === 1 && Number(pay.v) === fx.measurementTotal, { medicao: med, contas: pay });
    const rdo = await one('SELECT (SELECT count(*) FROM construction.daily_reports WHERE id = $1)::int AS original, (SELECT count(*) FROM construction.daily_reports WHERE id = $2 AND supersedes_id = $1)::int AS correcao', [fx.rdoOriginalId, fx.rdoRevisionId]);
    check('diário original preservado e correção apontando para ele', rdo.original === 1 && rdo.correcao === 1, rdo);
    const ev = await one(`SELECT (SELECT status FROM construction.nonconformities WHERE id = $1) AS nc,
      (SELECT status FROM construction.maintenance_cases WHERE id = $2) AS garantia,
      (SELECT count(*) FROM people.files f WHERE f.id = ANY((SELECT before_evidence_file_ids || after_evidence_file_ids FROM construction.nonconformities WHERE id = $1)::uuid[]))::int AS fotos_nc,
      (SELECT count(*) FROM people.files f WHERE f.id = ANY((SELECT before_media_file_ids || after_media_file_ids FROM construction.maintenance_cases WHERE id = $2)::uuid[]))::int AS fotos_garantia`, [fx.nonconformityId, fx.warrantyCaseId]);
    check('NC e garantia fechadas com as fotos antes/depois existentes em people.files', ev.nc === 'CLOSED' && ev.garantia === 'CLOSED' && ev.fotos_nc === 2 && ev.fotos_garantia === 2, ev);
    const mov = await one("SELECT coalesce(sum(CASE WHEN movement_type = 'OUT' THEN quantity END), 0)::numeric AS saida, coalesce(sum(CASE WHEN movement_type = 'RETURN' THEN quantity END), 0)::numeric AS devolucao FROM inventory.inventory_movements WHERE source_id = $1", [fx.materialRequestId]);
    check('requisição do canteiro: saída 40 e devolução 5 (movimento inverso) restauradas', Number(mov.saida) === 40 && Number(mov.devolucao) === 5, mov);
    const loss = await one("SELECT (SELECT movement_type FROM construction.loss_records WHERE id = $1) AS perda, (SELECT count(*) FROM construction.loss_records WHERE related_loss_record_id = $1 AND movement_type = 'RETURN')::int AS estornos", [fx.lossRecordId]);
    check('perda original preservada e estorno vinculado', loss.perda === 'LOSS' && loss.estornos === 1, loss);
    const { rows: evs } = await dst.query('SELECT DISTINCT event_type FROM integration.outbox_events WHERE event_type = ANY($1::text[])', [EVENTOS]);
    const faltam = EVENTOS.filter((e) => !evs.some((r) => r.event_type === e));
    check('eventos mínimos de Obras presentes na Outbox restaurada', faltam.length === 0, faltam.length ? { faltam } : `${EVENTOS.length} tipos`);

    console.log('3. Segurança no destino');
    const { rows: rls } = await dst.query("SELECT c.relname, c.relrowsecurity AS e, c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'construction' AND c.relkind = 'r'");
    const semRls = rls.filter((r) => !r.e || !r.f).map((r) => r.relname);
    check('RLS ENABLE + FORCE em todas as tabelas de Obras', semRls.length === 0, semRls.length ? { semRls } : `${rls.length} tabelas`);
    const app = await connect(arg('--target-app-url'));
    try {
      const semCtx = (await app.query('SELECT count(*)::int AS n FROM construction.projects')).rows[0].n;
      check('role de runtime sem contexto de empresa não vê nenhuma obra', semCtx === 0, `${semCtx} linhas`);
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.group_id', $1, true), set_config('app.company_id', $2, true)", [fx.tenant.groupId, fx.tenant.companyId]);
      const comCtx = (await app.query('SELECT count(*)::int AS n FROM construction.projects WHERE id = $1', [fx.projectId])).rows[0].n;
      check('com o contexto da empresa a obra do drill aparece', comCtx === 1, `${comCtx} linha`);
      let dup = null;
      try {
        await app.query('SAVEPOINT s');
        await app.query(`INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, status, amount, description, idempotency_key, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, 'DEBIT', 'PAYABLE', 'PENDING', 1, 'reprocesso pós-restore', $3, now(), now())`, [fx.tenant.groupId, fx.tenant.companyId, `measurement.payable:${fx.measurementId}`]);
      } catch (err) {
        dup = err.code;
      }
      await app.query('ROLLBACK');
      check('reprocessar measurement.approved após o restore não cria segunda conta a pagar (UNIQUE)', dup === '23505', `erro do banco: ${dup || 'nenhum'}`);
    } finally {
      await app.end();
    }
    const report = { geradoEm: new Date().toISOString(), aprovado: results.every((r) => r.ok), comparacao, verificacoes: results };
    if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify(report, null, 2));
    console.log(`Resultado da verificação: ${report.aprovado ? 'APROVADA' : 'REPROVADA'} (${results.filter((r) => r.ok).length}/${results.length})`);
    process.exitCode = report.aprovado ? 0 : 1;
  } finally {
    await src.end();
    await dst.end();
  }
}

main().catch((err) => {
  console.error(`❌ verifyConstructionRestore: ${err.message}`);
  process.exit(1);
});
