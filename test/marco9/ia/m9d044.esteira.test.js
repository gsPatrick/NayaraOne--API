'use strict';

// M9-D044 — a esteira de CI da NAY: os 16 estágios na ordem do livro, os 12 primeiros automáticos e parando no primeiro vermelho, o
// typecheck que reprova erro de tipo e a recusa de qualquer outra ordem. Estes testes não usam banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('../_helpers/iaEsteira');
const E = require('../../../scripts/ai-ci/lib/estagios');

const NOMES = ['lint', 'typecheck', 'migrations', 'tool schema tests', 'permission tests', 'RAG isolation tests', 'injection suite + adversarial',
  'grounding golden set', 'hallucination tests', 'budget/router tests', 'provider contract tests', 'privacy/log redaction', 'DEV', 'LAB', 'red-team', 'production approval'];

test('m9d044_script_executa_12_estagios_em_ordem', () => {
  const real = E.carregar(H.REAL);
  assert.deepEqual(real.map((e) => e.nome), NOMES, 'os 16 estágios, na ordem do livro');
  assert.deepEqual(real.map((e) => e.numero), NOMES.map((_, i) => i + 1));
  assert.ok(real.slice(0, 12).every((e) => e.tipo === 'automatico'), 'os 12 primeiros são automáticos');
  assert.ok(real.slice(12).every((e) => e.tipo === 'registro'), 'os 4 últimos exigem registro humano');
  const sh = fs.readFileSync(path.join(H.API, 'scripts', 'ci-estagios-ai.sh'), 'utf8');
  assert.match(sh, /scripts\/ai-ci\/executar\.js/);
  assert.match(sh, /withDisposableDb\.js/);
  assert.equal(spawnSync('bash', ['-n', path.join(H.API, 'scripts', 'ci-estagios-ai.sh')]).status, 0, 'sintaxe do script');

  const e = H.esteiraFalsa();
  const r = H.executar(e, ['--ate', '12']);
  assert.equal(r.status, 0, r.saida);
  assert.deepEqual(e.rodou(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'cada estágio roda uma vez, na ordem');
  assert.equal(r.relatorio.resultado, 'VERDE');
  assert.deepEqual(r.relatorio.estagios.map((x) => x.status), Array(12).fill('VERDE'));
  assert.deepEqual([...r.log.matchAll(/^# estagio (\d+): .* => VERDE$/gm)].map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'log por estágio arquivado');
});

test('m9d044_para_no_primeiro_estagio_vermelho', () => {
  const e = H.esteiraFalsa({ vermelho: [6] });
  const r = H.executar(e);
  assert.equal(r.status, 1);
  assert.deepEqual(e.rodou(), [1, 2, 3, 4, 5, 6], 'os estágios 7 a 12 nem rodam');
  const status = Object.fromEntries(r.relatorio.estagios.map((x) => [x.numero, x.status]));
  assert.equal(status[6], 'VERMELHO');
  for (let n = 7; n <= 16; n += 1) assert.equal(status[n], 'NAO_RODOU', `estágio ${n}`);
  assert.equal(r.relatorio.resultado, 'VERMELHO');
  assert.match(r.log, /# estagio 6: RAG isolation tests => VERMELHO/);
  assert.doesNotMatch(r.log, /# estagio 7:/);
  // dois vermelhos: só o primeiro conta
  const dois = H.esteiraFalsa({ vermelho: [2, 9] });
  H.executar(dois);
  assert.deepEqual(dois.rodou(), [1, 2]);
});

test('m9d044_estagio_fora_de_ordem_ou_manual_e_recusado', () => {
  const trocado = H.esteiraFalsa({ ajustar: (l) => { [l[3], l[4]] = [l[4], l[3]]; } });
  const r = H.executar(trocado);
  assert.equal(r.status, 2);
  assert.match(r.saida, /ordem do livro não pode mudar/);
  assert.deepEqual(trocado.rodou(), [], 'nada rodou');
  const manual = H.esteiraFalsa({ ajustar: (l) => { l[4] = { numero: 5, nome: 'permission tests', tipo: 'registro', item: 'X' }; } });
  const m = H.executar(manual);
  assert.equal(m.status, 2);
  assert.match(m.saida, /nenhum de 1 a 12 pode ser manual/);
  const faltando = H.esteiraFalsa({ ajustar: (l) => { l.splice(8, 1); } });
  assert.equal(H.executar(faltando).status, 2);
  assert.ok(E.problemasDaDefinicao(H.lerReal().estagios).length === 0);
});

test('m9d044_estagio_2_reprova_erro_de_tipo', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(H.API, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['typecheck:ai'], 'tsc --noEmit --allowJs --checkJs -p src/features/ai/tsconfig.json');
  assert.deepEqual(H.lerReal().estagios[1].comandos, [['npm', 'run', 'typecheck:ai']]);
  const limpo = spawnSync('npm', ['run', '--silent', 'typecheck:ai'], { cwd: H.API, encoding: 'utf8' });
  assert.equal(limpo.status, 0, `o código atual precisa passar no typecheck:\n${limpo.stdout}${limpo.stderr}`);

  // contrato violado: um adapter de teste chama generate() com argumento do tipo errado
  const dir = H.pastaTemp();
  fs.copyFileSync(path.join(H.API, 'src/features/ai/contracts/types.js'), path.join(dir, 'types.js'));
  fs.copyFileSync(path.join(H.API, 'src/features/ai/contracts/globals.d.ts'), path.join(dir, 'globals.d.ts'));
  fs.writeFileSync(path.join(dir, 'erro.js'), "'use strict';\n/** @param {ProviderGenerateRequest} r */\nfunction pedir(r) { return r.model; }\npedir({ model: 7, messages: 'x', maxOutputTokens: 'muitos' });\nmodule.exports = { pedir };\n");
  const config = JSON.parse(fs.readFileSync(path.join(H.API, 'src/features/ai/tsconfig.json'), 'utf8'));
  config.files = ['globals.d.ts', 'types.js', 'erro.js'];
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config));
  const tsc = ['tsc', '--noEmit', '--allowJs', '--checkJs', '-p', path.join(dir, 'tsconfig.json')];
  const ruim = spawnSync('npx', tsc, { cwd: H.API, encoding: 'utf8' });
  assert.notEqual(ruim.status, 0, 'erro de tipo precisa reprovar');
  assert.match(ruim.stdout, /erro\.js.*error TS/);

  // e a esteira para no estágio 2 com esse erro
  const e = H.esteiraFalsa({ ajustar: (l) => { l[1].comandos.push(['npx', ...tsc]); } });
  const r = H.executar(e);
  assert.equal(r.status, 1);
  assert.deepEqual(e.rodou(), [1, 2]);
  assert.equal(r.relatorio.estagios[1].status, 'VERMELHO');
});
