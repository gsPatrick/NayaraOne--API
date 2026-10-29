'use strict';

/** Trechos de SQL compartilhados pelos detectores de duplicidade (M9-D805): normalização de texto e filtros de cadastro vivo. */
const ACCENTS = 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ';
const PLAIN = 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn';

/** Texto em minúsculas, sem acento nem pontuação, espaços colapsados. */
const normText = (column) => `trim(regexp_replace(lower(translate(coalesce(${column}, ''), '${ACCENTS}', '${PLAIN}')), '[^a-z0-9]+', ' ', 'g'))`;
/** Só os dígitos do texto (CPF, CNPJ, CEP). */
const digits = (column) => `regexp_replace(coalesce(${column}, ''), '\\D', '', 'g')`;
/** Letras e dígitos em maiúsculas (matrícula escrita de jeitos diferentes). */
const alnum = (column) => `regexp_replace(upper(coalesce(${column}, '')), '[^A-Z0-9]', '', 'g')`;

/** Pessoa viva: não apagada, não unida a outra. */
const livePerson = (alias) => `${alias}.company_id = :companyId AND ${alias}.deleted_at IS NULL AND ${alias}.merged_into_id IS NULL AND ${alias}.status <> 'MERGED'`;
const liveProperty = (alias) => `${alias}.company_id = :companyId AND ${alias}.deleted_at IS NULL AND ${alias}.merged_into_id IS NULL`;
/** Pessoa com o papel de fornecedor ativo agora. */
const supplierRole = (alias) => `EXISTS (SELECT 1 FROM people.person_roles r WHERE r.person_id = ${alias}.id AND r.role_code = :supplierRole AND r.deleted_at IS NULL AND (r.ends_at IS NULL OR r.ends_at > now()))`;

module.exports = { normText, digits, alnum, livePerson, liveProperty, supplierRole };
