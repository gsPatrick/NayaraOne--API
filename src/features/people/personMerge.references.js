'use strict';

const { QueryTypes } = require('sequelize');
const { REFERENCIAS_REVISADAS, REFERENCIAS_SEM_FK, TIPOS_DE_ARQUIVO } = require('./personMerge.catalog');

/**
 * Remapeamento de TODAS as referências à pessoa no merge (M3-04, DI-M3PE-5). Guia §4: `references.remapAllowedForeignKeys(tx, absorbedId,
 * canonicalId)`; livro §29 passo 5: "Em uma única transação, remapear FKs permitidas para canonical_person_id".
 *
 * As colunas vêm do CATÁLOGO do banco (pg_constraint: toda chave estrangeira que aponta para people.persons.id, simples ou composta), mais
 * as referências sem FK da lista fechada e os vínculos de arquivo. Cada coluna tem a sua política revisada em personMerge.catalog.js
 * (REMAPEAR, ESPECIAL ou FORA com motivo); o teste people.merge.referencias falha se uma FK nova aparecer no banco sem estar lá. Uma FK nova
 * que ainda não foi revisada NÃO fica órfã: é remapeada como REMAPEAR e listada em `naoRevisadas` na auditoria do merge.
 */
const ident = (value) => `"${String(value).replace(/"/g, '""')}"`;
const qualified = (name) => name.split('.').map(ident).join('.');

/** Toda coluna que aponta para people.persons(id) por chave estrangeira: [{ table: 'schema.tabela', column }], em ordem estável. */
async function personForeignKeys(transaction) {
  const rows = await transaction.sequelize.query(
    `SELECT DISTINCT n.nspname || '.' || c.relname AS table_name, a.attname AS column_name
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN LATERAL unnest(k.conkey, k.confkey) AS u(col, refcol) ON true
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.col
       JOIN pg_attribute r ON r.attrelid = k.confrelid AND r.attnum = u.refcol
      WHERE k.contype = 'f' AND k.confrelid = 'people.persons'::regclass AND r.attname = 'id'
      ORDER BY 1, 2`,
    { type: QueryTypes.SELECT, transaction }
  );
  return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

/** UPDATE e SELECT do papel da sessão em cada tabela (a tabela protegida por REVOKE não pode quebrar todo merge). */
async function tablePrivileges(tables, transaction) {
  if (!tables.length) return {};
  const rows = await transaction.sequelize.query(
    `SELECT t AS tabela, has_table_privilege(t, 'UPDATE') AS pode_update, has_table_privilege(t, 'SELECT') AS pode_select FROM unnest(ARRAY[:tables]::text[]) AS t`,
    { type: QueryTypes.SELECT, transaction, replacements: { tables } }
  );
  return Object.fromEntries(rows.map((r) => [r.tabela, { update: r.pode_update, select: r.pode_select }]));
}

async function assertNothingPointsTo(table, column, absorbedId, canSelect, transaction) {
  const AppError = require('../../utils/AppError');
  const bloqueio = () => AppError.conflict(
    'Não foi possível mesclar: há registro protegido contra alteração que aponta para a pessoa absorvida. Peça ajuda a quem administra o sistema.',
    'PERSON_MERGE_PROTECTED_REFERENCE', { referencia: `${table}.${column}` }
  );
  if (!canSelect) throw bloqueio();
  const [{ n }] = await transaction.sequelize.query(`SELECT count(*)::int AS n FROM ${qualified(table)} WHERE ${ident(column)} = :absorbedId`, { type: QueryTypes.SELECT, transaction, replacements: { absorbedId } });
  if (n > 0) throw bloqueio();
}

async function update(sql, replacements, transaction) {
  const [, meta] = await transaction.sequelize.query(sql, { replacements, transaction });
  return meta && typeof meta.rowCount === 'number' ? meta.rowCount : 0;
}

/** Passos ESPECIAIS antes do remapeamento (as chaves únicas que a troca simples de person_id violaria). Nunca apagam linha. */
async function prepararEspeciais(canonicalId, absorbedId, actorUserId, transaction) {
  const r = { canonicalId, absorbedId, actorUserId };
  // Papel repetido (a chave é pessoa + papel + empresa): a linha do absorvido é encerrada (deleted_at), as outras seguem para o canônico.
  await update(`UPDATE people.person_roles o SET deleted_at = now(), deleted_by = :actorUserId
     WHERE o.person_id = :absorbedId AND o.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM people.person_roles s WHERE s.person_id = :canonicalId AND s.role_code = o.role_code AND s.company_id = o.company_id)`, r, transaction);
  // Versão do documento (única por pessoa, empresa, tipo e versão): as do absorvido vão para depois da última do canônico, na mesma ordem.
  // Uma linha por vez, da maior versão para a menor, para a troca nunca encostar numa versão que ainda vai mudar.
  const docs = await transaction.sequelize.query(
    `SELECT d.id, d.version_no + m.maximo AS nova FROM people.person_documents d
       JOIN (SELECT company_id, document_type, max(version_no) AS maximo FROM people.person_documents WHERE person_id = :canonicalId GROUP BY 1, 2) m
         ON m.company_id = d.company_id AND m.document_type = d.document_type
      WHERE d.person_id = :absorbedId ORDER BY d.version_no DESC`,
    { type: QueryTypes.SELECT, replacements: r, transaction }
  );
  for (const doc of docs) await update('UPDATE people.person_documents SET version_no = :nova WHERE id = :id', { nova: doc.nova, id: doc.id }, transaction);
  // Um endereço atual por pessoa: se o canônico já tem, o do absorvido vira histórico (is_current = false), sem sumir.
  await update(`UPDATE people.person_addresses a SET is_current = false WHERE a.person_id = :absorbedId AND a.is_current = true
       AND EXISTS (SELECT 1 FROM people.person_addresses b WHERE b.person_id = :canonicalId AND b.company_id = a.company_id AND b.is_current = true)`, r, transaction);
}

/**
 * Remapeia, na transação do merge, tudo o que aponta para o absorvido. Devolve { remapeadas: { 'schema.tabela.coluna': n }, naoRevisadas: [...] }.
 * Só entram no mapa as colunas com linha movida.
 */
async function remapAllPersonReferences(canonicalId, absorbedId, actorUserId, transaction) {
  await prepararEspeciais(canonicalId, absorbedId, actorUserId, transaction);
  const remapeadas = {};
  const naoRevisadas = [];
  const alvos = [...(await personForeignKeys(transaction)), ...REFERENCIAS_SEM_FK.map(([table, column]) => ({ table, column }))];
  const privilegios = await tablePrivileges([...new Set(alvos.map((a) => a.table))], transaction);
  for (const { table, column } of alvos) {
    const chave = `${table}.${column}`;
    const politica = REFERENCIAS_REVISADAS[chave];
    if (politica && politica.politica === 'FORA') continue;
    if (!politica && !REFERENCIAS_SEM_FK.some(([t, c]) => t === table && c === column)) naoRevisadas.push(chave);
    if (!privilegios[table].update) {
      // Tabela que o papel da aplicação não pode alterar: só segue se nada nela aponta para a absorvida (nunca deixa referência órfã em silêncio).
      await assertNothingPointsTo(table, column, absorbedId, privilegios[table].select, transaction);
      continue;
    }
    const sql = chave === 'people.person_roles.person_id'
      // Papel que o canônico já tem (a linha do absorvido foi encerrada acima): a linha encerrada fica com o absorvido, como histórico.
      ? `UPDATE people.person_roles o SET person_id = :canonicalId WHERE o.person_id = :absorbedId
           AND NOT EXISTS (SELECT 1 FROM people.person_roles s WHERE s.person_id = :canonicalId AND s.role_code = o.role_code AND s.company_id = o.company_id)`
      : `UPDATE ${qualified(table)} SET ${ident(column)} = :canonicalId WHERE ${ident(column)} = :absorbedId`;
    const n = await update(sql, { canonicalId, absorbedId }, transaction);
    if (n) remapeadas[chave] = n;
  }
  const links = await update(
    'UPDATE people.file_links SET related_entity_id = :canonicalId WHERE related_entity_id = :absorbedId AND related_entity_type IN (:tipos)',
    { canonicalId, absorbedId, tipos: TIPOS_DE_ARQUIVO }, transaction
  );
  if (links) remapeadas['people.file_links.related_entity_id'] = links;
  // Fiadores adicionais da garantia: lista JSON de ids; o id da absorvida vira o da canônica, sem repetir quem já está na lista.
  const fiadores = await update(
    `UPDATE legal.guarantees SET additional_guarantor_person_ids = (SELECT jsonb_agg(DISTINCT CASE WHEN e = to_jsonb(CAST(:absorbedId AS text))
        THEN to_jsonb(CAST(:canonicalId AS text)) ELSE e END) FROM jsonb_array_elements(additional_guarantor_person_ids) e)
      WHERE jsonb_typeof(additional_guarantor_person_ids) = 'array' AND additional_guarantor_person_ids @> to_jsonb(ARRAY[CAST(:absorbedId AS text)])`,
    { canonicalId, absorbedId }, transaction
  );
  if (fiadores) remapeadas['legal.guarantees.additional_guarantor_person_ids'] = fiadores;
  return { remapeadas, naoRevisadas };
}

module.exports = { personForeignKeys, remapAllPersonReferences };
