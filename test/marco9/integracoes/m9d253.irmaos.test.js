'use strict';

// Marco 9, M9-D253/D258 — o item 15 do DoD (autochecagem) lê as demandas em Maturacao/ (sem remoto). No CI que declara CI_SEM_REPOS_IRMAOS=1 ele sai NAO_APLICAVEL_NO_CI, dito na saída
// e fora da contagem de itens com evidência; sem a declaração, a pasta ausente reprova. Prova pelo ambiente real sobre uma raiz temporária e pela função pura.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ITENS } = require('../../../scripts/int-ci/lib/dodItens');
const { executar } = require('../../../scripts/int-ci/lib/dod');
const { ambienteReal } = require('../../../scripts/int-ci/lib/dodAmbiente');
const { ambienteVerde } = require('../_helpers/m9d253Env');

const mdVerde = () => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs/integrations/MATRIZ_INT.md'), 'utf8');

function comEnv(valores, fn) {
  const antes = Object.fromEntries(Object.keys(valores).map((k) => [k, process.env[k]]));
  Object.entries(valores).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { return fn(); } finally { Object.entries(antes).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}

test('autochecagem_sem_demandas_e_nao_aplicavel_so_com_a_declaracao_do_ci', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d253-irm-'));
  fs.mkdirSync(path.join(raiz, 'scripts'));
  fs.writeFileSync(path.join(raiz, 'scripts', 'integrationAutocheck.js'), 'process.exit(1);\n');
  const semDemandas = path.join(raiz, 'sem-demandas');
  const autochecagem = (CI_SEM_REPOS_IRMAOS) => comEnv({ CI_SEM_REPOS_IRMAOS, ANALYTICS_DEMANDAS_DIR: semDemandas }, () => ambienteReal(raiz).autochecagem());
  assert.equal(autochecagem(undefined).code, 1, 'sem a declaração a autochecagem roda e reprova');
  assert.equal(autochecagem(undefined).naoAplicavel, undefined);
  assert.equal(autochecagem('true').code, 1, 'só o valor 1 vale');
  const ci = autochecagem('1');
  assert.deepEqual([ci.code, ci.naoAplicavel], [0, true]);
  assert.match(ci.motivo, /Maturacao\/demandas\/marco-9.*NAO foi calculada aqui/);
  fs.mkdirSync(path.join(semDemandas, 'marco-9'), { recursive: true });
  assert.equal(autochecagem('1').naoAplicavel, undefined, 'com a pasta presente a autochecagem roda mesmo com a variável');
});

test('dod_diz_nao_aplicavel_no_ci_no_item_15_sem_contar_como_evidencia', () => {
  const ok = ambienteVerde({ autochecagem: () => ({ code: 0, naoAplicavel: true, motivo: 'sem demandas' }) });
  const r = executar(ITENS, ok.amb, mdVerde());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NAO_APLICAVEL_NO_CI 15 Autochecagem do livro calculada \(sem demandas\)/);
  assert.match(r.stdout, /14 de 15 itens com evidência, 1 NAO_APLICAVEL_NO_CI/);
  const reprovada = executar(ITENS, ambienteVerde({ autochecagem: () => ({ code: 1 }) }).amb, mdVerde());
  assert.equal(reprovada.code, 1);
  assert.match(reprovada.stderr, /item 15 .*autochecagem reprovou/);
});
