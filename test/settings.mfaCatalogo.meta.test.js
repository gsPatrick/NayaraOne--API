'use strict';

// Teste meta (DI-DEC007-1): enumera o catálogo de parâmetros (Maturacao/demandas/parametros.csv) e falha se uma chave com exige_mfa_para_alterar = "sim"
// existir no SETTINGS_SCHEMA sem `requiresMfa: true` — chave nova do catálogo que entrar no código sem a marcação quebra aqui. Também falha se o dicionário
// marcar uma chave que o catálogo não pede (nem é equivalente declarada), para a marcação não crescer sem rastro. Chave que aparece mais de uma vez no
// catálogo com valores diferentes vale pela mais restritiva (MFA). Depende da pasta irmã Maturacao/ (test/helpers/repoIrmao.js).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { irmao, testeComIrmaos } = require('./helpers/repoIrmao');

const CSV = 'Maturacao/demandas/parametros.csv';
const test = testeComIrmaos([CSV]);

// Chave do catálogo -> chave equivalente no código (mesmo controle, nome diferente).
const EQUIVALENTES = Object.freeze({ 'conciliacao.auto_confirmacao_ativa': 'finance.reconciliation.auto_strong' });

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function catalogoComMfa() {
  const [header, ...rows] = parseCsv(fs.readFileSync(irmao(...CSV.split('/')), 'utf8'));
  const iKey = header.indexOf('chave');
  const iMfa = header.indexOf('exige_mfa_para_alterar');
  assert.ok(iKey >= 0 && iMfa >= 0, 'colunas chave e exige_mfa_para_alterar no catálogo');
  return new Set(rows.filter((r) => r[iMfa] && r[iMfa].trim().toLowerCase() === 'sim').map((r) => r[iKey].trim()));
}

test('mfa_catalogo_meta: toda chave do catálogo com MFA que existe no dicionário (ou a equivalente) tem requiresMfa; nenhuma marcação sem origem no catálogo', () => {
  const { SETTINGS_SCHEMA } = require('../src/features/settings/settings.service');
  const comMfa = catalogoComMfa();
  assert.ok(comMfa.size > 0, 'o catálogo tem chaves com MFA');
  const esperadas = new Set();
  for (const key of comMfa) {
    const codigo = SETTINGS_SCHEMA[key] ? key : EQUIVALENTES[key];
    if (codigo && SETTINGS_SCHEMA[codigo]) esperadas.add(codigo);
  }
  const faltando = [...esperadas].filter((key) => SETTINGS_SCHEMA[key].requiresMfa !== true);
  assert.deepEqual(faltando, [], `chaves do catálogo com exige_mfa_para_alterar = sim sem requiresMfa no SETTINGS_SCHEMA: ${faltando.join(', ')}`);
  const sobrando = Object.keys(SETTINGS_SCHEMA).filter((key) => SETTINGS_SCHEMA[key].requiresMfa === true && !esperadas.has(key));
  assert.deepEqual(sobrando, [], `requiresMfa sem pedido do catálogo: ${sobrando.join(', ')}`);
  for (const [catalogo, codigo] of Object.entries(EQUIVALENTES)) assert.ok(comMfa.has(catalogo) && SETTINGS_SCHEMA[codigo], `equivalência ${catalogo} -> ${codigo} vigente`);
  assert.equal(esperadas.size, 21); // 20 do catálogo até a DEC-007 + exportacao.crm.exige_mfa (DEC-049, M3CB)
});
