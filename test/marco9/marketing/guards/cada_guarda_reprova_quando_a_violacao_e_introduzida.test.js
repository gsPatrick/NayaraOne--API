'use strict';

// M9-D440 teste 9: para cada uma das 8 guardas, uma cópia do módulo Marketing com a violação injetada reprova com a mensagem em português (guarda, arquivo, linha e regra), e o módulo
// verdadeiro passa nas 8. A saída deste teste é a "prova documentada" arquivada em docs/evidencias/ci. Sem banco: lê só o código.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const g = require('../../_helpers/mktGuardas');
const mutacoes = require('../../../../scripts/marketing/mutation/guardas');

const NOMES = ['guard_no_hardcoded_cadence', 'guard_send_requires_cansend', 'guard_ai_output_requires_factual_validation', 'guard_public_payload_only',
  'guard_no_blind_retry', 'guard_kill_switch_always_checked', 'guard_review_after_case_resolved', 'guard_replay_is_safe'];

test('o_modulo_verdadeiro_passa_nas_8_guardas_e_na_ordem_do_livro', () => {
  const todas = g.rodarTodas(g.RAIZ);
  assert.deepEqual(todas.map((r) => r.guarda), NOMES);
  assert.deepEqual(todas.flatMap((r) => r.violacoes.map(g.formatar)), []);
});

for (const m of mutacoes) {
  test(`cada_guarda_reprova_quando_a_violacao_e_introduzida: ${m.id} (${m.guarda}): ${m.descricao}`, () => {
    const copia = g.copiaDoModulo(m.edicoes);
    try {
      const achadas = g.violacoesDe(m.guarda, copia);
      assert.ok(achadas.length >= 1, `a guarda ${m.guarda} deixou passar: ${m.descricao}`);
      for (const v of achadas) {
        const msg = g.formatar(v);
        assert.match(msg, new RegExp(`^MKT_GUARD_VIOLATION Violação de regra arquitetural do Marketing: \\[${m.guarda}\\] \\S+:\\d+ \\S`), msg);
        assert.ok(v.arquivo && Number.isInteger(v.linha) && v.linha >= 1 && v.regra.length > 20, 'arquivo, linha e regra');
      }
      // a guarda aponta o arquivo que foi mexido (ou criado)
      const mexidos = m.edicoes.map((e) => e.arquivo.replace('src/features/marketing/', ''));
      assert.ok(achadas.some((v) => mexidos.includes(v.arquivo) || v.arquivo !== '(raiz)'), 'o achado cita um arquivo do módulo');
      console.log(`  prova: ${g.formatar(achadas[0])}`);
    } finally {
      fs.rmSync(copia, { recursive: true, force: true });
    }
  });
}

test('as_8_guardas_tem_ao_menos_uma_violacao_injetada_cada', () => {
  assert.deepEqual([...new Set(mutacoes.map((m) => m.guarda))].sort(), [...NOMES].sort());
});

test('o_portao_de_ci_sai_com_1_na_copia_com_violacao_e_com_0_no_modulo_verdadeiro', () => {
  const { spawnSync } = require('node:child_process');
  const ok = spawnSync('node', [`${g.RAIZ}/scripts/checkMarketingGuards.js`], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const copia = g.copiaDoModulo(mutacoes[0].edicoes);
  try {
    const ruim = spawnSync('node', [`${g.RAIZ}/scripts/checkMarketingGuards.js`, '--raiz', copia], { encoding: 'utf8' });
    assert.equal(ruim.status, 1);
    assert.match(ruim.stderr, /MKT_GUARD_VIOLATION Violação de regra arquitetural do Marketing: \[guard_no_hardcoded_cadence\] automations\/violacao\.cadencia\.js:3 /);
  } finally {
    fs.rmSync(copia, { recursive: true, force: true });
  }
});
