'use strict';

// Marco 9, M9-D221 — o domínio não decide por fornecedor: nenhum `if (provider === '...')` nos módulos de CRM, Jurídico e na troca/contrato. A varredura completa do repositório é da M9-D257.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', '..', 'src', 'features');
const PADRAO = /\b(providerCode|provider|provider_code)\s*(===|!==|==|!=)\s*['"][a-z0-9]+-[a-z0-9-]+['"]/;
const DOMINIOS = ['crm', 'legal', 'integrations/swap', 'integrations/contract'];

function arquivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? arquivos(path.join(dir, d.name)) : (d.name.endsWith('.js') ? [path.join(dir, d.name)] : [])));
}
const violacoes = (texto) => texto.split('\n').map((l, i) => ({ linha: i + 1, texto: l })).filter((l) => PADRAO.test(l.texto) && !/^\s*(\/\/|\*)/.test(l.texto));

test('swap_dominio_sem_if_de_provider', () => {
  const achados = DOMINIOS.flatMap((d) => arquivos(path.join(SRC, d)).flatMap((f) => violacoes(fs.readFileSync(f, 'utf8')).map((v) => `${path.relative(SRC, f)}:${v.linha} ${v.texto.trim()}`)));
  assert.deepEqual(achados, [], 'o domínio só conhece o port: nada de decisão pelo código do fornecedor');
  // A varredura enxerga a violação quando ela existe.
  assert.equal(violacoes("if (connection.providerCode === 'messaging-sandbox') {}").length, 1);
  assert.equal(violacoes("const a = x.provider !== 'signature-clicksign';").length, 1);
  assert.equal(violacoes('const ok = connection.providerCode === outro.providerCode;').length, 0);
});
