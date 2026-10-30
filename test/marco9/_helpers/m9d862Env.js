'use strict';

// Apoio dos testes M9-D862 com banco (não é teste): fábricas de arquivo, fila, ledger de volume, chamadas de IA e bucket. Banco descartável obrigatório.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueryTypes } = require('sequelize');
const base = require('./m9d860Env');
const { readDetectorParams } = require('../../../src/features/core-governance/finops/detectors/detectors.params');
const { shiftDay } = require('../../../src/features/core-governance/finops/detectors/volume.series');

const { sequelize } = base;
const NOW = new Date('2026-10-30T12:00:00.000Z');
const DAY = '2026-10-29'; // dia fechado que os detectores diários olham quando NOW = 30/10
const daysAgo = (n, from = NOW) => new Date(from.getTime() - n * 86400000);

const q = (tx, sql, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction: tx, replacements });

/** Arquivo do módulo de arquivos criado `age` dias antes de NOW. Opções: uploader (id do usuário), key, bytes. */
async function file(tenant, tx, { age = 45, uploader = null, key, bytes = 1000 } = {}) {
  const storageKey = key || `docs/${tenant.groupId}/${base.uniq()}.bin`;
  const [row] = await q(tx, `INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, mime_type, size_bytes, uploaded_by_user_id, created_at)
    VALUES (gen_random_uuid(), :g, :c, :key, 'qa.bin', 'application/octet-stream', :bytes, :uploader, :at) RETURNING id, storage_key`,
  { g: tenant.groupId, c: tenant.companyId, key: storageKey, bytes, uploader, at: daysAgo(age) });
  return row;
}

async function link(tenant, tx, fileId) {
  await q(tx, `INSERT INTO people.file_links (id, group_id, company_id, file_id, related_entity_type, related_entity_id, purpose)
    VALUES (gen_random_uuid(), :g, :c, :f, 'QA', gen_random_uuid(), 'QA')`, { g: tenant.groupId, c: tenant.companyId, f: fileId });
}

/** `n` eventos do outbox no estado dado, `ageMin` minutos mais velhos que NOW. */
async function outbox(tenant, tx, n, { status = 'PENDING', ageMin = 1 } = {}) {
  await q(tx, `INSERT INTO integration.outbox_events (id, group_id, company_id, aggregate_type, aggregate_id, event_type, event_version, payload_json, idempotency_key, occurred_at, status, retry_count, created_at)
    SELECT gen_random_uuid(), :g, :c, 'qa', gen_random_uuid(), 'qa.fila', 1, '{}'::jsonb, 'qa862-' || gen_random_uuid(), :at, :status, 0, :at FROM generate_series(1, :n)`,
  { g: tenant.groupId, c: tenant.companyId, n, status, at: new Date(NOW.getTime() - ageMin * 60000) });
}

/** Esvazia a fila PENDING da empresa DENTRO da transação do teste (reverte no rollback): resto de outros arquivos no mesmo banco não entra na contagem do limite. */
async function emptyQueues(tenant, tx) {
  for (const table of ['integration.outbox_events', 'integration.dispatches']) {
    await q(tx, `UPDATE ${table} SET status = 'SENT' WHERE company_id = :c AND status = 'PENDING'`, { c: tenant.companyId });
  }
}

/** Remove, dentro da transação do teste, os findings da empresa deixados por outros arquivos (o http grava de verdade), para o ciclo abrir/atualizar partir do zero. */
const resetFindings = (tenant, tx) => q(tx, 'DELETE FROM governance.finops_findings WHERE company_id = :c', { c: tenant.companyId });

/** Série de volume no ledger: um valor por dia (mais antigo primeiro), terminando em `lastDay`. */
async function volumes(tenant, tx, spec, values, lastDay = DAY) {
  const lines = values.map((v, i) => base.dayLine(tenant, shiftDay(lastDay, -(values.length - 1 - i)), {
    category: spec.category, service: spec.service, usageQuantity: String(v), usageUnit: spec.unit, amountCents: 0, companyId: spec.shared ? null : tenant.companyId, sourceRef: base.uniq(),
  }));
  await base.record(tenant, lines, tx);
}

/** Chamadas de IA no dia DAY: `n` chamadas do modelo com o custo (em reais, texto) cada. */
async function aiRuns(tenant, tx, { n, model, cost, path: routing = 'SMALL_MODEL', cached = false }) {
  await q(tx, `INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, status, cost_amount, routing_path, provider_code, model_code, cached, started_at)
    SELECT gen_random_uuid(), :g, :c, 'qa', 'COMPLETED', :cost, :routing, 'qa-prov', :model, :cached, :at FROM generate_series(1, :n)`,
  { g: tenant.groupId, c: tenant.companyId, n, model, cost, routing, cached, at: new Date(base.midnightSp(DAY).getTime() + 3 * 3600000) });
}

const findings = (tenant, tx, where = 'TRUE', replacements = {}) => q(tx, `SELECT * FROM governance.finops_findings WHERE company_id = :c AND ${where} ORDER BY detector, subject, first_seen_at`, { c: tenant.companyId, ...replacements });
const params = (tenant, tx) => readDetectorParams(tenant, tx);

/** Pasta de uploads temporária da empresa: devolve { root, put(rel, {bytes, ageDays}) } e aponta UPLOADS_DIR para ela. */
function bucket(tenant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d862-'));
  process.env.UPLOADS_DIR = root;
  const put = (rel, { bytes = 100, ageDays = 45 } = {}) => {
    const file = path.join(root, 'company', String(tenant.companyId).toLowerCase(), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    const t = daysAgo(ageDays);
    fs.utimesSync(file, t, t);
    return file;
  };
  const cleanup = () => { delete process.env.UPLOADS_DIR; fs.rmSync(root, { recursive: true, force: true }); };
  return { root, put, cleanup };
}

module.exports = { ...base, NOW, DAY, daysAgo, file, link, outbox, emptyQueues, resetFindings, volumes, aiRuns, findings, params, bucket, q, sequelize };
