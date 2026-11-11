'use strict';

/**
 * Contagem (SOMENTE LEITURA) dos cadastros de pessoa com CPF/CNPJ de dígito verificador inválido (M3-01, DI-M3PE-1).
 * Nada é alterado nem apagado: a decisão pelo livro é marcar para revisão (marca TAX_ID_DIGITO_INVALIDO na ficha e regra PERSON_TAX_ID_VALID
 * da qualidade de cadastro, que põe o cadastro na fila do steward). Imprime só números por empresa, nunca o CPF/CNPJ nem o nome.
 *
 * Uso (na pasta da API, com a conexão de LEITURA no ambiente, nunca escrita em arquivo):
 *   DATABASE_URL=... node scripts/people/contarCpfCnpjInvalidos.js [--json saida.json]
 * Usa a conexão de DATABASE_ADMIN_URL quando existir (leitura de todas as empresas); senão, DATABASE_URL.
 */
const fs = require('node:fs');
const { Client } = require('pg');
const { isValidTaxIdDigits } = require('../../src/features/people/personDocumentFormat.service');

async function main() {
  const url = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Defina DATABASE_URL (ou DATABASE_ADMIN_URL) no ambiente.');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(
      `SELECT company_id, tax_id_normalized AS t, status, deleted_at IS NOT NULL AS excluida FROM people.persons WHERE tax_id_normalized IS NOT NULL AND tax_id_normalized <> ''`
    );
    await client.query('ROLLBACK');
    const porEmpresa = {};
    let invalidos = 0;
    for (const row of rows) {
      const digits = String(row.t).replace(/\D/g, '');
      if (isValidTaxIdDigits(digits)) continue;
      invalidos += 1;
      const e = (porEmpresa[row.company_id] = porEmpresa[row.company_id] || { invalidos: 0, ativos: 0, mesclados: 0, excluidos: 0 });
      e.invalidos += 1;
      if (row.excluida) e.excluidos += 1; else if (row.status === 'MERGED') e.mesclados += 1; else e.ativos += 1;
    }
    const saida = { geradoEm: new Date().toISOString(), comDocumento: rows.length, invalidos, porEmpresa, decisao: 'Marcar para revisão (DI-M3PE-1); nada apagado nem alterado.' };
    const at = process.argv.indexOf('--json');
    if (at !== -1 && process.argv[at + 1]) fs.writeFileSync(process.argv[at + 1], `${JSON.stringify(saida, null, 2)}\n`);
    console.log(JSON.stringify(saida, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
