'use strict';

const { sequelize } = require('../../../../models');

/**
 * Próximo número do RPS da empresa na série (M9-D241 3.2): contador atômico por empresa e série (INSERT ... ON CONFLICT DO UPDATE ... RETURNING serializa os pedidos
 * simultâneos pela linha do contador). Roda na MESMA transação que grava a nota: se a nota não nasce, o número volta. O número só avança: a correção de uma nota recusada
 * ganha outro, nunca reaproveita. Devolve { series, number, key }; `key` é a chave de idempotência do envio, derivada do RPS.
 */
async function allocateRps({ groupId, companyId }, series, transaction) {
  const [[linha]] = await sequelize.query(
    `INSERT INTO correspondent.nfse_rps_sequences (group_id, company_id, series, last_number, updated_at) VALUES (:g, :c, :s, 1, now())
     ON CONFLICT (company_id, series) DO UPDATE SET last_number = correspondent.nfse_rps_sequences.last_number + 1, updated_at = now() RETURNING last_number`,
    { replacements: { g: groupId, c: companyId, s: series }, transaction },
  );
  const number = Number(linha.last_number);
  return { series, number, key: `nfse-rps:${series}-${number}` };
}

/** O RPS como o port o entende (série e número como texto, o número sem zeros à esquerda). */
const rpsOf = (invoice) => (invoice.rpsNumber === null || invoice.rpsNumber === undefined ? null : { series: invoice.rpsSeries, number: String(invoice.rpsNumber) });

module.exports = { allocateRps, rpsOf };
