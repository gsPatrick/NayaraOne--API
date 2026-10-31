'use strict';

// Apoio dos testes M9-D900 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Estes testes COMMITAM dados (o executor abre
// transações próprias), por isso cada teste usa um sistema de origem exclusivo e o cluster é apagado ao final.
const { randomUUID } = require('node:crypto');
const base = require('./m9d805Env');
const { dbError } = require('./dbAttempt');
const { adminQuery } = require('../../m9d801.helpers');
const connectors = require('../../../src/features/migration-v2/ingest/connectors');
const { executeRun } = require('../../../src/features/migration-v2/ingest/executor');
const runsService = require('../../../src/features/migration-v2/ingest/runs.service');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');
const { isoMicros } = require('../../../src/features/migration-v2/ingest/tokens');

const { sequelize } = base;
const sysName = () => `T${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

/**
 * Sistema antigo de mentira em memória, com os três jeitos de ler: log de eventos (CDC), linhas com updated_at (WATERMARK) e exportação completa (FULL_DIFF).
 * `state.keepOrder` devolve os eventos na ordem em que foram inseridos (origem defeituosa); `state.reads` conta as leituras.
 */
function fakeLegacy() {
  const state = { events: [], rows: new Map(), reads: 0 };
  const connector = {
    async readEvents({ after, upTo, limit }) {
      state.reads += 1;
      const list = state.events.filter((e) => BigInt(e.position) > BigInt(after) && (!upTo || BigInt(e.position) <= BigInt(upTo)));
      return (state.keepOrder ? list : list.sort((a, b) => Number(BigInt(a.position) - BigInt(b.position)))).slice(0, limit);
    },
    async readRows({ afterTs, afterKey, upTo, limit }) {
      state.reads += 1;
      const list = [...state.rows.entries()].map(([sourceKey, v]) => ({ sourceKey, updatedAt: isoMicros(v.updatedAt), record: v.record }))
        .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.sourceKey < b.sourceKey ? -1 : 1) : (a.updatedAt < b.updatedAt ? -1 : 1)));
      const after = (r) => !afterTs || r.updatedAt > afterTs || (r.updatedAt === afterTs && r.sourceKey > afterKey);
      const before = (r) => !upTo || r.updatedAt < upTo.ts || (r.updatedAt === upTo.ts && r.sourceKey <= upTo.key);
      return list.filter((r) => after(r) && before(r)).slice(0, limit);
    },
    async readAllRows({ afterKey, upToKey, limit }) {
      return [...state.rows.entries()].map(([sourceKey, v]) => ({ sourceKey, record: v.record })).filter((r) => r.sourceKey > afterKey && (!upToKey || r.sourceKey <= upToKey)).sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : 1)).slice(0, limit);
    },
    async listKeys() { return [...state.rows.keys()].sort(); },
    async close() {},
  };
  return {
    state, connector,
    event: (sourceKey, op, position, record = {}) => state.events.push({ sourceKey: String(sourceKey), op, position: String(position), record }),
    row: (sourceKey, updatedAt, record) => state.rows.set(String(sourceKey), { updatedAt, record }),
    drop: (sourceKey) => state.rows.delete(String(sourceKey)),
  };
}

/** Pessoa canônica válida (CPF gerado). */
const personRecord = (extra = {}) => ({ legalName: `QA-M9 Cliente ${base.suffix()}`, personType: 'PF', taxId: base.cpf(), ...extra });

/** CNPJ válido (dígitos verificadores calculados) e distinto a cada chamada, para o teste não colidir com pessoa deixada por execução anterior. */
function cnpj() {
  const d = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).concat([0, 0, 0, 1]);
  for (const len of [12, 13]) {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = d.slice(0, len).reduce((a, n, i) => a + n * w[i], 0) % 11;
    d.push(sum < 2 ? 0 : 11 - sum);
  }
  return d.join('');
}

/** Cria a fonte da empresa (com commit) e registra o conector falso sob um nome exclusivo. Devolve { system, fake, source(), dispose() }. */
async function installSource(tenant, { mode = 'CDC', entity = 'PERSON', columnMap = {}, system = sysName() } = {}) {
  const fake = fakeLegacy();
  const name = `FAKE_${system}_${entity}`; // uma origem por (sistema, entidade): duas entidades do mesmo sistema não podem dividir o conector
  connectors.register(name, async () => fake.connector);
  await adminQuery(
    `INSERT INTO governance.mig_sources (group_id, company_id, source_system, entity, mode, mode_reason, config, secret_ref) VALUES ($1, $2, $3, $4, $5, 'QA-M9: origem simulada do teste', $6::jsonb, NULL)`,
    [tenant.groupId, tenant.companyId, system, entity, mode, JSON.stringify({ connector: name, columnMap })]
  );
  const source = async () => (await adminQuery('SELECT * FROM governance.mig_sources WHERE company_id = $1 AND source_system = $2 AND entity = $3', [tenant.companyId, system, entity])).rows[0];
  return { system, entity, fake, source, dispose: () => connectors.unregister(name) };
}

/** Enfileira e executa uma execução (como o job faria) e devolve { runId, result }. */
async function run(tenant, { sourceSystem, entity, lastDelta = false } = {}) {
  const { runId } = await openTenantTx(tenant, (tx) => runsService.createRun(tenant, { userId: tenant.userId }, { sourceSystem, entity, lastDelta }, tx));
  return { runId, result: await executeRun(tenant, runId) };
}

/**
 * Execução registrada (createRun) mas encerrada na hora, para testes que só precisam de um `runId` válido nos lotes que aplicam à mão. A M9-D900 limita as execuções ativas por empresa,
 * e uma QUEUED esquecida travaria os pedidos seguintes de todos os testes que dividem o banco.
 */
async function closedRun(tenant, body) {
  const { runId } = await openTenantTx(tenant, (tx) => runsService.createRun(tenant, { userId: tenant.userId }, body, tx));
  await adminQuery("UPDATE governance.mig_runs SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1", [runId]);
  return { runId };
}

const q = async (sql, params) => (await adminQuery(sql, params)).rows;
const batchesOf = (system) => q('SELECT * FROM governance.mig_batches WHERE source_system = $1 ORDER BY created_at, id', [system]);
const recordsOf = (system) => q('SELECT * FROM governance.mig_records WHERE source_system = $1 ORDER BY source_key', [system]);
const keysOf = (system) => q("SELECT idempotency_key FROM governance.mig_event_keys WHERE idempotency_key LIKE $1 ORDER BY 1", [`${system}:%`]);

module.exports = { dbError, ...base, adminQuery, sysName, fakeLegacy, personRecord, cnpj, installSource, run, closedRun, q, batchesOf, recordsOf, keysOf, openTenantTx, connectors, sequelize };
