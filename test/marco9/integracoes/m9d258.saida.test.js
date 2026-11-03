'use strict';

// Marco 9, M9-D258 — a saída da autochecagem nunca leva segredo, caminho absoluto nem payload, e o script real liga ao Definition of Done (D253).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compute } = require('../../../scripts/int-autocheck/lib/compute');
const { renderizar } = require('../../../scripts/int-autocheck/lib/saida');
const { ITENS } = require('../../../scripts/int-ci/lib/dodItens');
const { executar } = require('../../../scripts/int-ci/lib/dod');
const { ambienteVerde: ambDod } = require('../_helpers/m9d253Env');
const { ambienteVerde, idsDoBloco, demandaOk } = require('../_helpers/m9d258Ambiente');

const RAIZ = path.join(__dirname, '..', '..', '..');
const montar = (...partes) => partes.join('');

test('autocheck_saida_sem_segredo_nem_caminho_absoluto', () => {
  const chave = montar('sk-ant-api03-', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  const bearer = montar('Bearer ', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD');
  const caminho = path.join(RAIZ, 'docs/runbooks/integrations/x.md');
  const demandas = () => [...idsDoBloco.map((id) => demandaOk(id)), { ...demandaOk('M9-D241'), erros: [`token ${chave} e ${bearer} em ${caminho} e /Users/outra.pessoa/Desktop/segredo.txt e C:\\Users\\alguem\\x.txt`] }];
  const s = renderizar(compute({ ambiente: ambienteVerde({ demandas }).amb }));
  const tudo = `${s.stdout}${s.stderr}`;
  assert.equal(s.code, 1);
  assert.ok(!tudo.includes(chave) && !tudo.includes(bearer), 'segredo redigido');
  assert.ok(!tudo.includes(RAIZ), 'caminho da máquina removido');
  assert.ok(!/\/Users\/|[A-Za-z]:\\/.test(tudo), 'nenhum caminho absoluto');
  assert.match(tudo, /docs\/runbooks\/integrations\/x\.md/, 'o caminho relativo do repositório continua útil');
  // Saída do script real, sobre o repositório de verdade, também limpa.
  const p = spawnSync('node', ['scripts/integrationAutocheck.js'], { cwd: RAIZ, encoding: 'utf8', env: { ...process.env, DISPOSABLE_DB: '' } });
  const real = `${p.stdout}${p.stderr}`;
  assert.ok(!real.includes(RAIZ) && !/\/Users\/|[A-Za-z]:\\/.test(real));
  assert.ok(!/(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{20,})/.test(real));
});

test('autocheck_ligada_ao_integration_dod_exit_1', () => {
  // O item 15 do DoD tem o script como arquivo e como evidência executada.
  const item = ITENS.find((i) => i.n === 15);
  assert.ok(item.evidencias.some((e) => e.arquivo === 'scripts/integrationAutocheck.js') && item.evidencias.some((e) => e.autochecagem));
  assert.ok(fs.existsSync(path.join(RAIZ, 'scripts/integrationAutocheck.js')));
  // Autochecagem que sai com 1 reprova o item 15 e o DoD inteiro (exit 1).
  const { amb } = ambDod({ autochecagem: () => ({ code: 1, output: 'Está blindado? NÃO.' }) });
  const r = executar(ITENS, amb, fs.readFileSync(path.join(RAIZ, 'docs/integrations/MATRIZ_INT.md'), 'utf8'));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /INTEGRATION_DOD_ITEM_MISSING.*item 15.*autochecagem reprovou \(saída 1\)/);
  // O DoD real executa o script de verdade: numa raiz com o script, o código de saída dele decide o item (aqui, um script que sai com 1).
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d258-'));
  try {
    fs.mkdirSync(path.join(raiz, 'scripts'));
    fs.writeFileSync(path.join(raiz, 'scripts/integrationAutocheck.js'), 'console.log("Está blindado? NÃO."); process.exit(1);\n');
    const { ambienteReal } = require('../../../scripts/int-ci/lib/dodAmbiente');
    // Sem a declaração do CI (CI_SEM_REPOS_IRMAOS) o script roda de verdade; o caso declarado é de m9d253.irmaos.test.js.
    const declarado = process.env.CI_SEM_REPOS_IRMAOS;
    delete process.env.CI_SEM_REPOS_IRMAOS;
    try { assert.equal(ambienteReal(raiz).autochecagem().code, 1); } finally { if (declarado !== undefined) process.env.CI_SEM_REPOS_IRMAOS = declarado; }
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
  // O script real sai com 1 e INTEGRATION_DOD_AUTOCHECK_FAILED quando o fato falta (pasta de demandas inexistente).
  const p = spawnSync('node', ['scripts/integrationAutocheck.js', '--demandas', path.join(os.tmpdir(), 'm9d258-nao-existe')], { cwd: RAIZ, encoding: 'utf8', env: { ...process.env, DISPOSABLE_DB: '' } });
  assert.equal(p.status, 1);
  assert.match(p.stderr, /INTEGRATION_DOD_AUTOCHECK_FAILED Marcelo não consegue fazer sozinho: /);
  for (const pergunta of ['Marcelo consegue fazer sozinho?', 'Está blindado?', 'Tem caminho técnico?', 'Outro programador assume?']) assert.ok(p.stdout.includes(pergunta), pergunta);
});
