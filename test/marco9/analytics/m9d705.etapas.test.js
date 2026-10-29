'use strict';

// M9-D705 — a esteira do BI: 14 etapas na ordem do livro, cada uma bloqueia as seguintes, o resultado de cada etapa é arquivado e as etapas
// 5, 7, 9, 10 e 11 juntas rodam os 15 testes nomeados da suíte adversarial (M9-D704). Sem banco: o executor das etapas é injetado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ETAPAS, NOMES_DO_LIVRO } = require('../../../scripts/analytics/ci/etapas');
const { runPipeline } = require('../../../scripts/analytics/ci/pipeline');
const { ADVERSARIAIS } = require('../_helpers/m9d704Mapa');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm9d705-'));
const ok = async () => ({ code: 0, output: 'ok\n' });

test('m9d705 o pipeline declara as 14 etapas na ordem do livro', () => {
  assert.deepEqual(NOMES_DO_LIVRO, ['lint', 'typecheck', 'migrations', 'metric formula tests', 'read model idempotency', 'reconciliation tests', 'RLS',
    'quality checks', 'alert dedup', 'export security', 'load/rebuild', 'DEV', 'LAB', 'owner reconciliation']);
  assert.deepEqual(ETAPAS.map((e) => e.n), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.deepEqual(ETAPAS.map((e) => e.livro), NOMES_DO_LIVRO);
  assert.deepEqual(ETAPAS.map((e) => e.fase), [...Array(11).fill('pr'), ...Array(3).fill('promocao')], 'etapas 1 a 11 em todo pull request; 12 a 14 na promoção');
  for (const e of ETAPAS) assert.ok(e.comandos.length >= 1, `etapa ${e.n} sem comando`);
});

test('m9d705 cada etapa bloqueia a seguinte e o resumo aponta a etapa e o motivo', async () => {
  const dir = tmp();
  const rodadas = [];
  const executar = async (cmd) => { rodadas.push(cmd.etapa); return cmd.etapa === 4 ? { code: 1, output: 'Fórmula sem teste de tabela: finX.js\n' } : { code: 0, output: 'ok' }; };
  const r = await runPipeline({ fase: 'tudo', executar, saida: dir });
  assert.equal(r.ok, false);
  assert.ok(Math.max(...rodadas) === 4, 'nada roda depois da etapa reprovada');
  const por = Object.fromEntries(r.etapas.map((e) => [e.n, e.status]));
  assert.deepEqual([por[1], por[2], por[3], por[4], por[5], por[14]], ['APROVADA', 'APROVADA', 'APROVADA', 'REPROVADA', 'BLOQUEADA', 'BLOQUEADA']);
  const e4 = r.etapas[3];
  assert.match(e4.motivo, /Fórmula sem teste de tabela/);
  assert.match(r.etapas[4].motivo, /etapa 4/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'resumo.json'), 'utf8')).ok, false);
});

test('m9d705 a fase pr roda as etapas 1 a 11 e a promoção só roda depois', async () => {
  const pr = await runPipeline({ fase: 'pr', executar: ok, saida: tmp() });
  assert.equal(pr.ok, true);
  assert.deepEqual(pr.etapas.filter((e) => e.status === 'APROVADA').map((e) => e.n), Array.from({ length: 11 }, (_, i) => i + 1));
  assert.deepEqual(pr.etapas.filter((e) => e.status === 'FORA_DA_FASE').map((e) => e.n), [12, 13, 14]);
  const promo = await runPipeline({ fase: 'promocao', executar: ok, saida: tmp() });
  assert.deepEqual(promo.etapas.filter((e) => e.status === 'APROVADA').map((e) => e.n), [12, 13, 14]);
});

test('m9d705 resultado de cada etapa é arquivado', async () => {
  const dir = tmp();
  // segredos fictícios montados em tempo de execução (a varredura de segredo do repositório não pode achá-los no arquivo)
  const bearer = ['Bear', 'er ', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
  const conexao = ['postgres', '://u:', 'senhasecreta', '@host/db'].join('');
  const executar = async (cmd) => ({ code: 0, output: `saída da etapa ${cmd.etapa} Authorization: ${bearer} e ${conexao}\n` });
  await runPipeline({ fase: 'tudo', executar, saida: dir });
  const arquivos = fs.readdirSync(dir).sort();
  assert.equal(arquivos.filter((f) => /^etapa-\d\d-.*\.log$/.test(f)).length, 14);
  assert.ok(arquivos.includes('resumo.json'));
  const resumo = JSON.parse(fs.readFileSync(path.join(dir, 'resumo.json'), 'utf8'));
  assert.equal(resumo.etapas.length, 14);
  for (const e of resumo.etapas) {
    assert.ok(e.status && e.inicio && e.fim && e.log, `etapa ${e.n} sem status, horários ou log`);
    const log = fs.readFileSync(path.join(dir, e.log), 'utf8');
    assert.match(log, new RegExp(`saída da etapa ${e.n}\\b`));
    assert.doesNotMatch(log, /abcdefghijklmnopqrstuvwxyz0123456789|senhasecreta/, 'segredo nunca aparece no log do pipeline');
  }
});

test('m9d705 as etapas 5, 7, 9, 10 e 11 rodam os 15 testes da suíte adversarial', () => {
  const alvo = new Set([5, 7, 9, 10, 11]);
  const cobertos = new Set();
  for (const e of ETAPAS.filter((x) => alvo.has(x.n))) {
    const adv = e.comandos.filter((c) => c.args.includes('test/marco9/analytics/m9d704.adversarial.test.js'));
    assert.ok(adv.length >= 1, `etapa ${e.n} não roda a suíte adversarial`);
    for (const c of adv) {
      const padrao = c.args[c.args.indexOf('--test-name-pattern') + 1];
      for (const a of ADVERSARIAIS) if (new RegExp(padrao).test(a.nome)) cobertos.add(a.nome);
    }
  }
  assert.deepEqual([...cobertos].sort(), ADVERSARIAIS.map((a) => a.nome).sort());
});
