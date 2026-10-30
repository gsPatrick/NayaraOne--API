'use strict';

const { divHalfEven, safeNumber } = require('../money');
const { orphanFiles, knownKeys } = require('./orphan.db');
const { bucketOrphans } = require('./orphan.bucket');

/** bytes x preço do GB-mês (centavos x 1e6) / bytes de 1 GB, em centavos inteiros (half-even): 120 GB a R$ 0,10 = 1.200 centavos. */
const wasteOf = (bytes, params) => {
  const price = params.finops.prices.storage_gb_mes;
  return price === undefined ? 0 : safeNumber(divHalfEven(bytes * price, params.finops.gbBase ** 3n * 1000000n));
};

/**
 * Storage órfão (M9-D862 §3.1), por empresa: (1) arquivo em `files` sem vínculo e sem dono há mais de `orfao_dias` dias; (2) objeto no bucket sem linha em `files`.
 * Cada lado vira um achado agregado (assunto `files:orfaos` e `bucket:sem-linha`) com contagem, bytes e a estimativa mensal. Só lê: não apaga nem move nada.
 */
async function detectOrphanStorage(tenant, now, params, transaction) {
  const cutoff = new Date(now.getTime() - params.orphanDays * 86400000);
  const found = [];
  const db = await orphanFiles(tenant, cutoff, transaction);
  if (db.count > 0) {
    found.push({ subject: 'files:orfaos', wasteCents: wasteOf(db.bytes, params), evidence: { arquivos: db.count, bytes: db.bytes.toString(), semVinculoHaDias: params.orphanDays, amostraIds: db.ids } });
  }
  const bucket = bucketOrphans(tenant.companyId, await knownKeys(tenant, transaction), cutoff);
  if (bucket.count > 0) {
    found.push({ subject: 'bucket:sem-linha', wasteCents: wasteOf(bucket.bytes, params), evidence: { objetos: bucket.count, bytes: bucket.bytes.toString(), semLinhaHaDias: params.orphanDays } });
  }
  return found;
}

module.exports = { detectOrphanStorage };
