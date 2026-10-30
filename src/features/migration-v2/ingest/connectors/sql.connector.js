'use strict';

const { Client } = require('pg');
const errors = require('../ingest.errors');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ident = (name) => {
  if (!IDENT.test(String(name))) throw errors.connectorMissing('SQL:identificador');
  return `"${name}"`;
};
const relation = (name) => String(name).split('.').map(ident).join('.');
const TS = (column) => `to_char(${ident(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Conector SQL somente leitura. `config`: relation (tabela/visão com a linha completa), keyColumn, updatedAtColumn (WATERMARK), e para CDC logRelation + positionColumn + opColumn
 * (a tabela de log traz a chave, a posição, a operação e as colunas da linha). Só SELECT; o endereço do banco sai da variável de ambiente nomeada em `secret_ref`.
 */
async function createSqlConnector(source) {
  const config = source.config || {};
  const url = source.secret_ref ? process.env[source.secret_ref] : null;
  if (!url) throw errors.secretMissing();
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  const key = ident(config.keyColumn);

  const strip = (row, drop) => { const out = { ...row }; for (const column of drop) delete out[column]; return out; };

  return {
    async readEvents({ after, upTo, limit }) {
      const position = ident(config.positionColumn);
      const { rows } = await client.query(
        `SELECT ${position}::text AS "__position", ${ident(config.opColumn)} AS "__op", ${key}::text AS "__key", * FROM ${relation(config.logRelation)}
          WHERE ${position} > $1::numeric AND ($2::numeric IS NULL OR ${position} <= $2::numeric) ORDER BY ${position} LIMIT $3`,
        [after || '0', upTo || null, limit]
      );
      return rows.map((row) => ({ sourceKey: row.__key, op: row.__op, position: row.__position, record: strip(row, ['__position', '__op', '__key', config.positionColumn, config.opColumn]) }));
    },
    async readRows({ afterTs, afterKey, upTo, limit }) {
      const { rows } = await client.query(
        `SELECT ${TS(config.updatedAtColumn)} AS "__ts", ${key}::text AS "__key", * FROM ${relation(config.relation)}
          WHERE (${ident(config.updatedAtColumn)}, ${key}::text) > ($1::timestamptz, $2::text)
            AND ($3::timestamptz IS NULL OR (${ident(config.updatedAtColumn)}, ${key}::text) <= ($3::timestamptz, $4::text)) ORDER BY ${ident(config.updatedAtColumn)}, ${key}::text LIMIT $5`,
        [afterTs || '-infinity', afterKey || '', upTo ? upTo.ts : null, upTo ? upTo.key : null, limit]
      );
      return rows.map((row) => ({ sourceKey: row.__key, updatedAt: row.__ts, record: strip(row, ['__ts', '__key']) }));
    },
    async readAllRows({ afterKey, upToKey, limit }) {
      const { rows } = await client.query(
        `SELECT ${key}::text AS "__key", * FROM ${relation(config.relation)} WHERE ${key}::text > $1 AND ($2::text IS NULL OR ${key}::text <= $2) ORDER BY ${key}::text LIMIT $3`,
        [afterKey || '', upToKey || null, limit]
      );
      return rows.map((row) => ({ sourceKey: row.__key, record: strip(row, ['__key']) }));
    },
    async listKeys() {
      const { rows } = await client.query(`SELECT ${key}::text AS k FROM ${relation(config.relation)} ORDER BY 1`);
      return rows.map((row) => row.k);
    },
    close: () => client.end(),
  };
}

module.exports = { createSqlConnector };
