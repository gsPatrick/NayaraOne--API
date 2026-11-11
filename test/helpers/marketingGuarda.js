'use strict';

// Ciclo down/up das migrations 750 e 751 (marketing.schema.test e marketing.schema.execucao.models.test) num banco em que OUTROS arquivos já gravaram, com commit,
// linhas no schema marketing. O down só roda com as tabelas vazias (não apaga dados, de propósito), então esses testes dependiam da ordem dos arquivos. Aqui as
// linhas de fora são guardadas num schema temporário antes do ciclo e devolvidas depois da recomposição, iguais, nas mesmas tabelas: o teste trabalha só com o
// que é dele e o banco fica como estava para os arquivos seguintes. Superusuário do banco descartável; FK e gatilhos desligados só durante a guarda e a devolução.
const crypto = require('node:crypto');

const TABLES_SQL = `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'marketing' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname`;
const COLUMNS_SQL = `SELECT a.attname AS col FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = :s AND c.relname = :t AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum`;

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Guarda (e tira) as linhas que já existem no schema marketing. Devolve { schema, tabelas: [{ t, n }] }. */
async function guardar(admin) {
  const schema = `zz_guarda_mkt_${crypto.randomBytes(4).toString('hex')}`;
  const tabelas = [];
  await admin.transaction(async (transaction) => {
    await admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await admin.query(`CREATE SCHEMA ${schema}`, { transaction });
    const [rows] = await admin.query(TABLES_SQL, { transaction });
    for (const { t } of rows) {
      const [[{ n }]] = await admin.query(`SELECT count(*)::int AS n FROM marketing.${quote(t)}`, { transaction });
      if (n === 0) continue;
      await admin.query(`CREATE TABLE ${schema}.${quote(t)} AS SELECT * FROM marketing.${quote(t)}`, { transaction });
      await admin.query(`DELETE FROM marketing.${quote(t)}`, { transaction });
      tabelas.push({ t, n });
    }
  });
  return { schema, tabelas };
}

/** Devolve as linhas guardadas às tabelas recompostas (colunas em comum, pelo nome) e apaga o schema da guarda. Confere a contagem de cada tabela. */
async function devolver(admin, { schema, tabelas }) {
  await admin.transaction(async (transaction) => {
    await admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { t, n } of tabelas) {
      const [mine] = await admin.query(COLUMNS_SQL, { replacements: { s: 'marketing', t }, transaction });
      const [kept] = await admin.query(COLUMNS_SQL, { replacements: { s: schema, t }, transaction });
      const keptSet = new Set(kept.map((r) => r.col));
      const cols = mine.map((r) => r.col).filter((c) => keptSet.has(c)).map(quote).join(', ');
      await admin.query(`INSERT INTO marketing.${quote(t)} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM ${schema}.${quote(t)}`, { transaction });
      const [[{ back }]] = await admin.query(`SELECT count(*)::int AS back FROM marketing.${quote(t)}`, { transaction });
      if (back !== n) throw new Error(`marketing.${t}: guardadas ${n} linha(s), devolvidas ${back}`);
    }
    await admin.query(`DROP SCHEMA ${schema} CASCADE`, { transaction });
  });
}

/** Roda `fn` com o schema marketing sem as linhas de outros arquivos e as devolve no fim, mesmo se `fn` falhar. `fn` precisa deixar o schema recomposto. */
async function comMarketingSoDoTeste(admin, fn) {
  const guarda = await guardar(admin);
  try {
    return await fn();
  } finally {
    await devolver(admin, guarda);
  }
}

module.exports = { comMarketingSoDoTeste, guardar, devolver };
