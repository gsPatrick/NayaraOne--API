'use strict';

// M9-D414 (rodada 5, G-1) — a varredura única de URL (envio direto, definição de automação, template e legenda) usa o mesmo extrator linear da M9-D433 e o teto de tamanho
// vale ANTES de varrer, para o campo no limite do parâmetro (20 mil caracteres) com texto patológico: recusa com 422 em muito menos que o evento de 1,3 s da auditoria.
// Pura, sem banco: limites e configuração vêm do contexto.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../../../src/features/marketing/security');
const { config } = require('../_helpers/urlCorpus');

const limits = { maxVariable: 2000, maxField: 20000, maxTotal: 100000, blockReview: true };
const ctx = { tenant: {}, limits, config, origin: 'SYSTEM' };
const PATOLOGICOS = ['.', ',', ';', ':', '!', '?', '_', '-', '*', '=', '@', '%', '/', '̀'];

test('campo_no_limite_com_texto_patologico_e_varrido_em_milissegundos', async () => {
  for (const ch of PATOLOGICOS) {
    const campo = `evil.com/${ch.repeat(19000)}a`;
    const started = process.hrtime.bigint();
    await assert.rejects(() => security.assertTextFieldsSafe([['corpo', campo], ['assunto', campo], ['legenda[0]', campo]], null, ctx), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED', JSON.stringify(ch));
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500, `${JSON.stringify(ch)}: três campos de 19 mil caracteres`);
  }
});

test('todos_os_pontos_aplicam_o_teto_antes_de_varrer_variavel_campo_total_array_e_profundidade', async () => {
  const casos = [
    [[['corpo', 'x'.repeat(20001)]], null, 'CAMPO_GRANDE_DEMAIS'],
    [[], { v: 'x'.repeat(2001) }, 'CAMPO_GRANDE_DEMAIS'],
    [[], { v: new Array(130000).fill('a') }, 'TEXTO_GRANDE_DEMAIS'],
    [[], { v: Object.fromEntries(Array.from({ length: 150000 }, (_, i) => [`k${i}`, 'a'])) }, 'TEXTO_GRANDE_DEMAIS'],
    [[['a', 'y'.repeat(20000)], ['b', 'y'.repeat(20000)], ['c', 'y'.repeat(20000)], ['d', 'y'.repeat(20000)], ['e', 'y'.repeat(20000)], ['f', 'y'.repeat(20000)]], null, 'TEXTO_GRANDE_DEMAIS'],
    [[], { v: { a: { b: { c: { d: { e: { f: { g: { h: { i: 'x' } } } } } } } } } }, 'CAMPO_GRANDE_DEMAIS'],
  ];
  for (const [texts, variables, reason] of casos) {
    const started = process.hrtime.bigint();
    await assert.rejects(() => security.assertTextFieldsSafe(texts, variables, ctx), (e) => e.statusCode === 422 && JSON.stringify(e.details || {}).includes(reason), reason);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1500, reason);
  }
});
