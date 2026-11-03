'use strict';

/**
 * RESOLVE pedido Seção 5 #5 da auditoria complementar da Nayara (Marcos 4/5, 14/10/2026):
 * "Evidência e meios reproduzíveis de restore/replay financeiro e jurídico, comparando dados e
 * arquivos não vazios, com origem controlada e hashes."
 *
 * Segue EXATAMENTE o mesmo padrão já validado e documentado em scripts/verifyRestoreConstructionData.js
 * (Marco 6, 08-09/10/2026) — reaproveita scripts/backupDatabase.js (pg_dump -Fc real) e
 * scripts/restoreDatabase.js (pg_restore real para um banco descartável), e compara ORIGEM x
 * DESTINO já restaurado, dentro do contexto RLS correto (SET LOCAL app.group_id/app.company_id
 * — ver scripts/verifyRestoreConstructionData.js para o porquê disso ser obrigatório).
 *
 * Diferencial pedido especificamente para Financeiro/Jurídico (vs. o script de Obras): além da
 * comparação campo a campo, este script recalcula e compara um HASH canônico sobre o conjunto
 * de dados financeiros/jurídicos do tenant de referência — origem x destino têm que produzir o
 * MESMO hash. Prova dois níveis: (1) que o restore físico (pg_dump/pg_restore) preserva os
 * dados sem perda; (2) que um hash sobre esse conjunto é um detector de adulteração real — se
 * alguém alterar um valor no destino depois do restore, o hash muda (ver
 * scripts/restoreReplayDrill.js, que testa esse caso de adulteração deliberada).
 *
 * Uso:
 *   node scripts/verifyRestoreFinanceLegalData.js --source-db <banco-origem> --target-db <banco-destino>
 */

require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');
const { resolveConnection } = require('./backupDatabase');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source-db' && argv[i + 1]) { out.sourceDb = argv[i + 1]; i += 1; }
    if (argv[i] === '--target-db' && argv[i + 1]) { out.targetDb = argv[i + 1]; i += 1; }
  }
  return out;
}

async function connectTo(conn, database) {
  const client = new Client({ host: conn.host, port: Number(conn.port), user: conn.user, password: conn.password, database });
  await client.connect();
  return client;
}

async function withTenantContext(client, { groupId, companyId }, fn) {
  await client.query('BEGIN');
  try {
    if (groupId) await client.query('SELECT set_config($1, $2, true)', ['app.group_id', groupId]);
    if (companyId) await client.query('SELECT set_config($1, $2, true)', ['app.company_id', companyId]);
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** findReferenceTenant — primeiro group/company (core.groups sem RLS) que tenha ao menos um
 * lançamento financeiro E um contrato com ao menos uma versão — pra garantir que a comparação
 * nunca fica vazia. */
async function findReferenceTenant(client) {
  const groupsRes = await client.query('SELECT id FROM core.groups ORDER BY created_at ASC');
  for (const { id: groupId } of groupsRes.rows) {
    // eslint-disable-next-line no-await-in-loop
    const companies = await withTenantContext(client, { groupId }, async () => {
      const res = await client.query('SELECT id FROM core.companies WHERE group_id = $1 ORDER BY created_at ASC', [groupId]);
      return res.rows;
    });
    for (const { id: companyId } of companies) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await withTenantContext(client, { groupId, companyId }, async () => {
        const fe = await client.query('SELECT COUNT(*)::int AS n FROM finance.financial_entries');
        const cv = await client.query(
          `SELECT COUNT(*)::int AS n FROM legal.contract_versions cv
           JOIN legal.contracts c ON c.id = cv.contract_id`
        );
        return fe.rows[0].n > 0 && cv.rows[0].n > 0;
      });
      if (ok) return { groupId, companyId };
    }
  }
  return null;
}

async function fetchFinancialEntries(client, ctx) {
  return withTenantContext(client, ctx, async () => {
    const res = await client.query(
      `SELECT id, entry_type AS "entryType", nature, amount, due_at AS "dueAt",
              status, idempotency_key AS "idempotencyKey", reversal_of_entry_id AS "reversalOfEntryId",
              created_at AS "createdAt"
       FROM finance.financial_entries
       ORDER BY created_at ASC`
    );
    return res.rows;
  });
}

async function fetchContractVersions(client, ctx) {
  return withTenantContext(client, ctx, async () => {
    const res = await client.query(
      `SELECT cv.id, cv.contract_id AS "contractId", cv.version_number AS "versionNumber",
              cv.content_hash AS "contentHash", cv.effective_from AS "effectiveFrom",
              c.contract_number AS "contractNumber", c.status AS "contractStatus"
       FROM legal.contract_versions cv
       JOIN legal.contracts c ON c.id = cv.contract_id
       ORDER BY cv.created_at ASC`
    );
    return res.rows;
  });
}

function normalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** canonicalHash — hash SHA-256 determinístico sobre um array de registros: ordena as chaves de
 * cada objeto, normaliza valores (Date -> ISO string), serializa como JSON estável. Mesma ideia
 * de "hash canônico" já usada em evidencePackages.service.js#computePackageHash, reimplementada
 * aqui de forma independente e auto-contida (este script não depende da camada de serviço —
 * lê direto do banco, igual ao verifyRestoreConstructionData.js). */
function canonicalHash(records) {
  const canonical = records.map((row) => {
    const sortedKeys = Object.keys(row).sort();
    const obj = {};
    for (const key of sortedKeys) obj[key] = normalize(row[key]);
    return obj;
  });
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function compareField(label, sourceValue, targetValue, checks) {
  const a = normalize(sourceValue);
  const b = normalize(targetValue);
  const ok = a === b;
  checks.push({ label, ok });
  console.log(ok ? `  ✅ idêntico — ${label}: "${a}"` : `  ❌ DIVERGÊNCIA: ${label} era "${a}", virou "${b}"`);
  return ok;
}

async function main() {
  const { sourceDb, targetDb } = parseArgs(process.argv.slice(2));
  if (!sourceDb || !targetDb) {
    throw new Error('Uso: node scripts/verifyRestoreFinanceLegalData.js --source-db <banco-origem> --target-db <banco-destino>');
  }

  const conn = resolveConnection();
  const source = await connectTo(conn, sourceDb);
  const target = await connectTo(conn, targetDb);
  const checks = [];
  let anyDivergence = false;

  try {
    console.log(`\n=== Comparando "${sourceDb}" (origem) x "${targetDb}" (destino) — Financeiro/Jurídico ===\n`);

    console.log('--- Localizando tenant de referência (precisa ter lançamento financeiro E contrato com versão) ---');
    const ref = await findReferenceTenant(source);
    if (!ref) throw new Error('Nenhum tenant com dados financeiros E jurídicos suficientes encontrado na origem.');
    console.log(`  Tenant de referência: group=${ref.groupId}, company=${ref.companyId}`);

    console.log('\n--- Lançamentos financeiros (finance.financial_entries) ---');
    const sourceEntries = await fetchFinancialEntries(source, ref);
    const targetEntries = await fetchFinancialEntries(target, ref);
    console.log(`  Origem: ${sourceEntries.length} lançamento(s). Destino: ${targetEntries.length} lançamento(s).`);
    if (sourceEntries.length === 0) throw new Error('Tenant de referência não tem lançamentos financeiros — fixture inválida.');
    const countOkEntries = sourceEntries.length === targetEntries.length;
    checks.push({ label: 'contagem financial_entries', ok: countOkEntries });
    anyDivergence = anyDivergence || !countOkEntries;
    console.log(countOkEntries ? '  ✅ contagem idêntica' : '  ❌ DIVERGÊNCIA de contagem');

    const targetEntriesById = new Map(targetEntries.map((e) => [e.id, e]));
    for (const sourceEntry of sourceEntries) {
      const targetEntry = targetEntriesById.get(sourceEntry.id);
      if (!targetEntry) {
        anyDivergence = true;
        checks.push({ label: `lançamento ${sourceEntry.id} presente no destino`, ok: false });
        console.log(`  ❌ DIVERGÊNCIA: lançamento "${sourceEntry.id}" existe na origem mas não no destino`);
        continue;
      }
      const ok = [
        compareField(`  ${sourceEntry.id} — entryType`, sourceEntry.entryType, targetEntry.entryType, checks),
        compareField(`  ${sourceEntry.id} — amount`, sourceEntry.amount, targetEntry.amount, checks),
        compareField(`  ${sourceEntry.id} — status`, sourceEntry.status, targetEntry.status, checks),
        compareField(`  ${sourceEntry.id} — idempotencyKey`, sourceEntry.idempotencyKey, targetEntry.idempotencyKey, checks),
      ];
      anyDivergence = anyDivergence || ok.some((v) => !v);
    }

    console.log('\n--- Hash canônico do conjunto de lançamentos financeiros ---');
    const sourceEntriesHash = canonicalHash(sourceEntries);
    const targetEntriesHash = canonicalHash(targetEntries);
    const entriesHashOk = sourceEntriesHash === targetEntriesHash;
    checks.push({ label: 'hash canônico financial_entries', ok: entriesHashOk });
    anyDivergence = anyDivergence || !entriesHashOk;
    console.log(`  Origem:  ${sourceEntriesHash}`);
    console.log(`  Destino: ${targetEntriesHash}`);
    console.log(entriesHashOk ? '  ✅ hash idêntico' : '  ❌ DIVERGÊNCIA de hash — dados restaurados não batem com a origem');

    console.log('\n--- Versões de contrato (legal.contract_versions), incluindo content_hash já gravado ---');
    const sourceVersions = await fetchContractVersions(source, ref);
    const targetVersions = await fetchContractVersions(target, ref);
    console.log(`  Origem: ${sourceVersions.length} versão(ões). Destino: ${targetVersions.length} versão(ões).`);
    if (sourceVersions.length === 0) throw new Error('Tenant de referência não tem versões de contrato — fixture inválida.');
    const countOkVersions = sourceVersions.length === targetVersions.length;
    checks.push({ label: 'contagem contract_versions', ok: countOkVersions });
    anyDivergence = anyDivergence || !countOkVersions;
    console.log(countOkVersions ? '  ✅ contagem idêntica' : '  ❌ DIVERGÊNCIA de contagem');

    const targetVersionsById = new Map(targetVersions.map((v) => [v.id, v]));
    for (const sourceVersion of sourceVersions) {
      const targetVersion = targetVersionsById.get(sourceVersion.id);
      if (!targetVersion) {
        anyDivergence = true;
        checks.push({ label: `versão ${sourceVersion.id} presente no destino`, ok: false });
        console.log(`  ❌ DIVERGÊNCIA: versão "${sourceVersion.id}" existe na origem mas não no destino`);
        continue;
      }
      const ok = [
        compareField(`  ${sourceVersion.id} — contractNumber`, sourceVersion.contractNumber, targetVersion.contractNumber, checks),
        compareField(`  ${sourceVersion.id} — versionNumber`, sourceVersion.versionNumber, targetVersion.versionNumber, checks),
        compareField(`  ${sourceVersion.id} — contentHash (já gravado no documento)`, sourceVersion.contentHash, targetVersion.contentHash, checks),
      ];
      anyDivergence = anyDivergence || ok.some((v) => !v);
    }

    console.log('\n--- Hash canônico do conjunto de versões de contrato ---');
    const sourceVersionsHash = canonicalHash(sourceVersions);
    const targetVersionsHash = canonicalHash(targetVersions);
    const versionsHashOk = sourceVersionsHash === targetVersionsHash;
    checks.push({ label: 'hash canônico contract_versions', ok: versionsHashOk });
    anyDivergence = anyDivergence || !versionsHashOk;
    console.log(`  Origem:  ${sourceVersionsHash}`);
    console.log(`  Destino: ${targetVersionsHash}`);
    console.log(versionsHashOk ? '  ✅ hash idêntico' : '  ❌ DIVERGÊNCIA de hash — dados restaurados não batem com a origem');

    console.log('\n--- Replay pós-restore: reenviar um lançamento com idempotencyKey já existente ---');
    const entryWithKey = sourceEntries.find((e) => e.idempotencyKey);
    if (!entryWithKey) {
      console.log('  (nenhum lançamento de referência tem idempotencyKey preenchida — replay não aplicável a este tenant)');
    } else {
      const replayOk = await withTenantContext(target, ref, async () => {
        try {
          await target.query(
            `INSERT INTO finance.financial_entries
               (id, group_id, company_id, entry_type, nature, amount, status, idempotency_key, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'CREDIT', 'RECEIVABLE', 1.00, 'PENDING', $3, now(), now())`,
            [ref.groupId, ref.companyId, entryWithKey.idempotencyKey]
          );
          return false; // inseriu sem erro = NÃO deveria ter acontecido
        } catch (err) {
          if (/unique|duplicate/i.test(err.message)) return true; // rejeitado corretamente
          throw err;
        }
      });
      checks.push({ label: 'replay com idempotencyKey duplicada é rejeitado pelo banco restaurado', ok: replayOk });
      anyDivergence = anyDivergence || !replayOk;
      console.log(
        replayOk
          ? `  ✅ replay de "${entryWithKey.idempotencyKey}" foi corretamente REJEITADO pela constraint UNIQUE sobrevivente ao restore`
          : `  ❌ DIVERGÊNCIA GRAVE: replay de "${entryWithKey.idempotencyKey}" foi ACEITO no banco restaurado — duplicaria lançamento`
      );
    }

    console.log('\n=== Resumo ===');
    const total = checks.length;
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`${total - failed}/${total} checagens idênticas.`);
    console.log(anyDivergence ? '❌ RESULTADO FINAL: divergência(s) encontrada(s) — ver detalhes acima.' : '✅ RESULTADO FINAL: nenhuma divergência encontrada entre origem e destino.');
  } finally {
    await source.end();
    await target.end();
  }

  if (anyDivergence) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, canonicalHash, findReferenceTenant };
