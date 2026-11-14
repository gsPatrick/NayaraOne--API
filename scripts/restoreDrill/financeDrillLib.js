'use strict';

/**
 * Utilitários do drill de restore FINANCEIRO (verifyFinanceRestore.js e replayFinanceRestore.js):
 * registro de checagens, normalização de valores, comparação campo a campo por objeto com
 * hash canônico SHA-256, e contexto de tenant numa conexão pg (SET LOCAL como o middleware).
 */
const crypto = require('crypto');

function createRecorder() {
  const results = [];
  function check(objectName, label, ok, detail = '') {
    results.push({ objectName, label, ok: Boolean(ok), detail });
    console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
    return Boolean(ok);
  }
  return { results, check };
}

function normalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Hash canônico: linhas ordenadas pela chave, colunas em ordem alfabética, valores normalizados. */
function canonicalHash(rows, keyOf) {
  const lines = rows
    .map((r) => [keyOf(r), Object.keys(r).sort().map((k) => [k, normalize(r[k])])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify(lines));
}

/**
 * compareObject — mesma query na origem e no destino (superusuário: compara o conteúdo bruto,
 * sem RLS), campo a campo pela chave. Nulo dos dois lados é contado à parte (não é cobertura).
 */
async function compareObject(rec, source, target, spec) {
  const { name, sql, params = [], minRecords = 0 } = spec;
  console.log(`\n--- ${name} ---`);
  const [s, t] = await Promise.all([source.query(sql, params), target.query(sql, params)]);
  const fields = s.fields.map((f) => f.name);
  const keyOf = (r) => (r.id !== undefined && r.id !== null ? String(r.id) : JSON.stringify(Object.keys(r).sort().map((k) => normalize(r[k]))));
  const tgt = new Map(t.rows.map((r) => [keyOf(r), r]));
  rec.check(name, `registros na origem: ${s.rows.length} (mínimo exigido ${minRecords})`, s.rows.length >= minRecords);
  rec.check(name, `mesma quantidade de registros (origem ${s.rows.length}, destino ${t.rows.length})`, s.rows.length === t.rows.length);
  let withValue = 0;
  let bothNull = 0;
  let failures = 0;
  const fieldsWithValue = new Set();
  for (const row of s.rows) {
    const other = tgt.get(keyOf(row));
    if (!other) {
      failures += 1;
      rec.check(name, `registro ${keyOf(row)} presente no destino`, false);
      continue;
    }
    for (const field of fields) {
      const a = normalize(row[field]);
      const b = normalize(other[field]);
      if (a === null && b === null) { bothNull += 1; continue; }
      withValue += 1;
      fieldsWithValue.add(field);
      if (a !== b) {
        failures += 1;
        rec.check(name, `${keyOf(row)}.${field}`, false, `origem "${a}" ≠ destino "${b}"`);
      }
    }
  }
  const hashSource = canonicalHash(s.rows, keyOf);
  const hashTarget = canonicalHash(t.rows, keyOf);
  if (s.rows.length > 0) {
    rec.check(name, `${withValue} comparações COM VALOR idênticas (${s.rows.length} registros × ${fields.length} campos; ${bothNull} nulo=nulo à parte)`, failures === 0 && withValue > 0);
  } else {
    rec.check(name, 'objeto vazio nos dois lados (sem dado de fixture neste objeto)', t.rows.length === 0);
  }
  rec.check(name, `hash canônico SHA-256 origem = destino (${hashSource.slice(0, 16)}…)`, hashSource === hashTarget, hashSource === hashTarget ? '' : `destino ${hashTarget.slice(0, 16)}…`);
  return {
    objectName: name, records: s.rows.length, fields, comparedWithValue: withValue, bothNull,
    alwaysNullFields: fields.filter((f) => !fieldsWithValue.has(f)), failures, hashSource, hashTarget, hashEqual: hashSource === hashTarget,
  };
}

/** Abre transação na conexão com o contexto de tenant (mesmo SET LOCAL do tenant.middleware). */
async function beginTenant(client, tenant) {
  await client.query('BEGIN');
  if (tenant && tenant.groupId) await client.query("SELECT set_config('app.group_id', $1, true)", [tenant.groupId]);
  if (tenant && tenant.companyId) await client.query("SELECT set_config('app.company_id', $1, true)", [tenant.companyId]);
  if (tenant && tenant.userId) await client.query("SELECT set_config('app.user_id', $1, true)", [tenant.userId]);
}

/** Executa SQL dentro de um SAVEPOINT e devolve o erro do banco (ou null) sem abortar a transação. */
async function sqlError(client, sql, params = []) {
  await client.query('SAVEPOINT sp_drill');
  try {
    await client.query(sql, params);
    await client.query('ROLLBACK TO SAVEPOINT sp_drill');
    return null;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp_drill');
    return err;
  }
}

module.exports = { createRecorder, normalize, sha256, canonicalHash, compareObject, beginTenant, sqlError };
