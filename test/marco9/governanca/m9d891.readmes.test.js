'use strict';

// M9-D891: os 8 READMEs de módulo têm as 9 seções fixas e documentam todo parâmetro governanca.* que o módulo usa. Teste de conteúdo de arquivos, sem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { GOV, MODULOS, SECOES, ler, chavesNoCodigo, secoes } = require('../_helpers/m9d891Docs');

const { GOVERNANCE_SETTING_DEFAULTS, GOVERNANCE_MODULES, moduleSettingKey } = require('../../../src/features/core-governance/governance.settings');

test('m9d891 todo README tem as 9 seções', () => {
  assert.equal(MODULOS.length, 8);
  assert.equal(GOVERNANCE_MODULES.length, 8, 'os 8 módulos do livro');
  assert.deepEqual(MODULOS.map((m) => m.pasta).sort(), GOVERNANCE_MODULES.map((m) => m.code).sort());
  for (const m of MODULOS) {
    const doc = secoes(ler(path.join(GOV, m.pasta, 'README.md')));
    const titulos = [...doc.keys()];
    for (const s of SECOES) {
      assert.ok(doc.has(s), `${m.pasta}: falta a seção "${s}"`);
      assert.ok(doc.get(s).length >= 40, `${m.pasta}: a seção "${s}" está vazia ou é só um título`);
    }
    // as 9 seções aparecem na ordem fixa
    const posicoes = SECOES.map((s) => titulos.indexOf(s));
    assert.deepEqual([...posicoes].sort((a, b) => a - b), posicoes, `${m.pasta}: as seções fora de ordem`);
  }
});

test('m9d891 todo parâmetro governanca.* usado no módulo está no README dele', () => {
  const faltas = [];
  for (const m of MODULOS) {
    const readme = ler(path.join(GOV, m.pasta, 'README.md'));
    const usados = chavesNoCodigo(m.pasta);
    for (const k of Object.keys(GOVERNANCE_SETTING_DEFAULTS)) if (m.segmentos.includes(k.split('.')[1])) usados.add(k);
    usados.add(moduleSettingKey(m.pasta));
    for (const k of usados) if (!readme.includes(k)) faltas.push(`${m.pasta}: ${k}`);
    assert.ok(usados.size >= 3, `${m.pasta}: nenhuma chave encontrada (o teste estaria vazio)`);
  }
  assert.deepEqual(faltas, []);
  // chaves transversais (ui, ações, erros, permissões) vivem no README da pasta core-governance
  const raiz = ler(path.join(GOV, 'README.md'));
  const transversais = Object.keys(GOVERNANCE_SETTING_DEFAULTS).filter((k) => ['ui', 'acoes', 'erros', 'permissoes'].includes(k.split('.')[1]));
  assert.ok(transversais.length >= 8);
  assert.deepEqual(transversais.filter((k) => !raiz.includes(k)), []);
});

test('m9d891 todo parâmetro governanca.* do catálogo de defaults pertence a um módulo ou ao README transversal', () => {
  const segmentos = new Set([...MODULOS.flatMap((m) => m.segmentos), 'ui', 'acoes', 'erros', 'permissoes', 'modulos']);
  const orfaos = Object.keys(GOVERNANCE_SETTING_DEFAULTS).filter((k) => !segmentos.has(k.split('.')[1]));
  assert.deepEqual(orfaos, [], 'chave sem README dono: acrescente o segmento ao módulo certo');
});
