'use strict';

// M9-D707 — o DoD do BI: 11 itens com prova automática; item sem demanda verificada, sem teste verde ou sem etapa da esteira reprova; tudo verde aprova.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ITENS } = require('../../../scripts/analytics/dod/itens');
const { avaliarDod } = require('../../../scripts/analytics/dod/avaliar');
const { problemasEstaticos, adversariaisVerdes, resumoDaSaida } = require('../../../scripts/analytics/dod/testes');
const { formatarMatriz, resumoDeReprovacao } = require('../../../scripts/analytics/dod/relatorio');
const { carregarDemandas } = require('../../../scripts/analytics/sprints/demandasMd');
const { montarFonte } = require('../_helpers/sprintsFonte');
const { montarEsteira } = require('../_helpers/esteiraFonte');
const { executorFalso, verificarVerde, saidaVerde, RESUMO, QUINZE } = require('../_helpers/dodFalso');

const RAIZ = path.join(__dirname, '..', '..', '..');
const TODAS = [...new Set(ITENS.flatMap((i) => i.demandas))];
const verificadas = () => Object.fromEntries(TODAS.map((id) => [id, 'verificada']));

async function rodar({ status = verificadas(), executor = executorFalso(), verificar = verificarVerde, esteira = {} } = {}) {
  const fonte = montarFonte({ sprints: { B1: TODAS }, status });
  const ev = montarEsteira(esteira);
  try {
    return await avaliarDod(ITENS, { demandas: carregarDemandas(fonte.dir), raiz: RAIZ, verificar, executar: executor.executar, esteira: { dir: ev.dir } });
  } finally { fonte.limpar(); ev.limpar(); }
}

test('m9d707 o script cobre os 11 itens do DoD', () => {
  assert.deepEqual(ITENS.map((i) => i.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(ITENS.map((i) => i.chave), ['registry', 'read-models', 'snapshots', 'dashboards', 'drill-down', 'alerts', 'quality', 'nay-briefs', 'export-security', 'adversariais', 'carga-rebuild-rls']);
  for (const i of ITENS) {
    assert.ok(i.demandas.length > 0, `item ${i.n} sem demanda`);
    assert.ok(i.testes.length > 0 || i.etapasCi, `item ${i.n} sem prova automática`);
    assert.deepEqual(problemasEstaticos(RAIZ, i), [], `item ${i.n} cita arquivo ou teste que não existe`);
  }
  const por = (n) => ITENS[n - 1].demandas;
  assert.deepEqual([por(1), por(3), por(5), por(9), por(10)], [['M9-D603', 'M9-D604'], ['M9-D609'], ['M9-D690', 'M9-D712'], ['M9-D701'], ['M9-D704']]);
  assert.deepEqual(por(2), ['M9-D607', 'M9-D615', 'M9-D616', 'M9-D617', 'M9-D618', 'M9-D619', 'M9-D627', 'M9-D628']);
  assert.ok(por(4).includes('M9-D687') && por(4).includes('M9-D685'));
  assert.deepEqual([por(6), por(7), por(8), por(11)], [['M9-D691', 'M9-D692', 'M9-D703'], ['M9-D696', 'M9-D697'], ['M9-D693', 'M9-D694', 'M9-D695'], ['M9-D699', 'M9-D608', 'M9-D700']]);
  assert.deepEqual(ITENS[10].etapasCi, [4, 6, 7, 11]);
  assert.equal(ITENS.some((i) => i.demandas.includes('M9-D708')), false, 'o aceite dos owners (M9-D708) é condição de produção, fora do DoD');
});

test('m9d707 item sem demanda verificada reprova', async () => {
  const r = await rodar({ status: { ...verificadas(), 'M9-D693': 'corrigida', 'M9-D696': 'em_execucao' } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.itens.filter((i) => !i.ok).map((i) => i.n), [7, 8]);
  assert.match(r.itens[7].motivos[0], /M9-D693: status corrigida/);
  assert.match(formatarMatriz(r), /^ 8\. NAY briefs: NÃO$/m);
  assert.match(resumoDeReprovacao(r), /7 \(Quality checks\); 8 \(NAY briefs\)/);
  const invalida = await rodar({ verificar: async (d) => (d.id === 'M9-D701' ? { ok: false, motivo: 'Implementador e verificador são a mesma pessoa' } : { ok: true }) });
  assert.deepEqual(invalida.itens.filter((i) => !i.ok).map((i) => i.n), [9]);
  assert.match(invalida.itens[8].motivos[0], /verificada sem registro válido.*mesma pessoa/);
  const semArquivo = await rodar({ status: Object.fromEntries(Object.entries(verificadas()).filter(([id]) => id !== 'M9-D609')) });
  assert.match(semArquivo.itens[2].motivos[0], /M9-D609: status/);
});

test('m9d707 item sem teste verde reprova', async () => {
  const vermelho = await rodar({ executor: executorFalso({ falhar: (c) => c.args.some((a) => a.includes('m9d690.detalhe')) }) });
  assert.deepEqual(vermelho.itens.filter((i) => !i.ok).map((i) => i.n), [5]);
  assert.match(vermelho.itens[4].motivos[0], /teste vermelho em .*m9d690\.detalhe.*primeiro vermelho: quebrou/);
  const semNome = await rodar({ executor: executorFalso({ saida: (c) => (c.args.some((a) => a.includes('m9d690.escopo')) ? `✔ outro teste (1ms)\n${RESUMO}` : null) }) });
  assert.match(semNome.itens[4].motivos.join(), /m9d690 cross-company detail é bloqueado com 404.*não aparece verde/);
  const pulado = await rodar({ executor: executorFalso({ saida: (c) => (c.args.some((a) => a.includes('m9d609.freshness')) ? `✔ x (1ms)\n${RESUMO.replace('skipped 0', 'skipped 2')}` : null) }) });
  assert.match(pulado.itens[2].motivos.join(), /2 teste\(s\) pulado\(s\)/);
  const catorze = await rodar({ executor: executorFalso({ saida: (c) => (c.args.some((a) => a.includes('m9d704.adversarial')) ? `${QUINZE.slice(0, 14).map((n) => `✔ ${n}`).join('\n')}\n${RESUMO}` : null) }) });
  assert.match(catorze.itens[9].motivos.join(), /14 verdes/);
  const scriptQuebrado = await rodar({ executor: executorFalso({ falhar: (c) => c.args.some((a) => a.includes('checkFormulaTests')) }) });
  assert.match(scriptQuebrado.itens[0].motivos.join(), /checkFormulaTests\.js saiu com 1/);
});

test('m9d707 item de carga/rebuild/RLS exige as etapas 4, 6, 7 e 11 da esteira', async () => {
  const sem7 = await rodar({ esteira: { status: { 7: 'REPROVADA' } } });
  assert.deepEqual(sem7.itens.filter((i) => !i.ok).map((i) => i.n), [11]);
  assert.match(sem7.itens[10].motivos.join(), /etapa 7: REPROVADA/);
  const outraEtapa = await rodar({ esteira: { status: { 9: 'REPROVADA' } } });
  assert.equal(outraEtapa.ok, true, 'a etapa 9 não é do item 11');
  const sem11 = await rodar({ esteira: { logEtapa11: '' } });
  assert.match(sem11.itens[10].motivos.join(), /dashboard pesado/);
});

test('m9d707 todos verdes devolve exit 0 e imprime os 11 itens com SIM', async () => {
  const exec = executorFalso();
  const r = await rodar({ executor: exec });
  assert.equal(r.ok, true, JSON.stringify(r.itens.filter((i) => !i.ok)));
  const texto = formatarMatriz(r);
  assert.equal((texto.match(/: SIM$/gm) || []).length, 11);
  assert.ok(exec.chamadas.filter((c) => c.banco).length >= 10, 'os testes rodam com banco: true (só em banco descartável)');
  assert.equal(adversariaisVerdes(saidaVerde()).length, 15);
  assert.equal(resumoDaSaida(saidaVerde()).pulados, 0);
});

test('m9d707 o script reprova com exit 1 e mensagem quando a ferramenta de verificação não existe', () => {
  const fonte = montarFonte({ sprints: { B1: TODAS } });
  try {
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'analytics', 'checkDod.js'), '--demandas', fonte.dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ferramenta de verificação não encontrada/);
  } finally { fonte.limpar(); }
});
