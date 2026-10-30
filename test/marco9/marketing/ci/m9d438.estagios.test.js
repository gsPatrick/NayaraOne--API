'use strict';

// M9-D438 — a esteira de CI do Marketing: os 14 estágios do Guia §12 na ordem do livro (arquivo de estágios e workflow), parando no primeiro vermelho, 1 a 11 em todo push e 12 a 14 em branch de
// entrega, e vermelha quando um teste exigido (adversarial ou guarda) é removido de uma suíte. Sem banco: o runner roda estágios de brinquedo como processo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { RAIZ, marcar, estagiosDeBrinquedo, executar, lerEstagios, E } = require('../../_helpers/mktEsteira');
const arvore = require('../../../../scripts/marketing/mutation/arvore');

const NOMES = ['lint', 'typecheck', 'migrations', 'automation idempotency', 'consent/suppression tests', 'factual grounding', 'public-field leakage tests', 'provider contract tests',
  'frequency/quiet-hours', 'kill-switch', 'tracking tests', 'DEV', 'LAB', 'failure drills'];
const workflow = () => yaml.load(fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'marketing-esteira.yml'), 'utf8'));

test('workflow_tem_14_estagios_na_ordem: o arquivo de estágios e o workflow listam os 14 estágios do Guia §12 com os nomes e a ordem do livro', () => {
  const estagios = lerEstagios();
  assert.deepEqual(estagios.map((e) => e.nome), NOMES);
  assert.deepEqual(estagios.map((e) => e.numero), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(E.problemasDaDefinicao(estagios), []);
  const w = workflow();
  const passos = [...w.jobs['esteira-marketing'].steps, ...w.jobs['entrega-marketing'].steps].filter((s) => /^Estágio \d+: /.test(s.name || ''));
  assert.deepEqual(passos.map((s) => s.name), NOMES.map((nome, i) => `Estágio ${i + 1}: ${nome}`), 'o workflow lista os 14 estágios com os nomes e na ordem do livro');
  for (const [i, passo] of passos.entries()) assert.match(passo.run, new RegExp(`--de ${i + 1} --ate ${i + 1}\\b`), `o passo do estágio ${i + 1} roda só o estágio ${i + 1}`);
  // 1 a 11 em todo push e pull request; 12 a 14 só em branch de entrega ou tag de release
  assert.ok(w.on.pull_request !== undefined && w.on.push);
  assert.equal(w.jobs['esteira-marketing'].steps.filter((s) => /^Estágio/.test(s.name || '')).length, 11);
  assert.equal(w.jobs['esteira-marketing'].if, undefined, 'os estágios 1 a 11 não têm condição: rodam sempre');
  assert.match(w.jobs['entrega-marketing'].if, /refs\/heads\/entrega\//);
  assert.equal(w.jobs['entrega-marketing'].needs, 'esteira-marketing', 'a entrega só começa com os estágios 1 a 11 verdes');
  assert.ok(w.on.push.branches.includes('entrega/**'));
  assert.ok(fs.readFileSync(path.join(RAIZ, 'scripts', 'ci-estagios-marketing.sh'), 'utf8').includes('scripts/marketing/ci/executar.js'));
});

test('workflow_tem_14_estagios_na_ordem: reordenar, renomear, faltar estágio ou mudar o tipo é recusado antes de rodar qualquer comando', () => {
  const estagios = lerEstagios();
  const trocados = [...estagios];
  [trocados[2], trocados[3]] = [trocados[3], trocados[2]];
  assert.ok(E.problemasDaDefinicao(trocados).length > 0, 'ordem trocada');
  assert.ok(E.problemasDaDefinicao(estagios.map((e) => (e.numero === 6 ? { ...e, nome: 'validação factual' } : e))).length > 0, 'nome trocado');
  assert.ok(E.problemasDaDefinicao(estagios.slice(0, 13)).length > 0, 'estágio faltando');
  assert.ok(E.problemasDaDefinicao(estagios.map((e) => (e.numero === 4 ? { ...e, tipo: 'entrega' } : e))).length > 0, 'estágio de push virando de entrega');
  assert.ok(E.problemasDaDefinicao(estagios.map((e) => (e.numero === 13 ? { ...e, tipo: 'push' } : e))).length > 0, 'estágio de entrega virando de push');
  assert.ok(E.problemasDaDefinicao(estagios.map((e) => (e.numero === 12 ? { ...e, comandos: [['npm', 'run', 'deploy-production']] } : e))).length > 0, 'deploy em produção');
  const r = executar(estagiosDeBrinquedo().reverse());
  assert.equal(r.status, 2);
  assert.deepEqual(r.marcas, [], 'esteira inválida não roda comando nenhum');
});

test('ci_falha_em_um_estagio_bloqueia_os_seguintes: o estágio vermelho interrompe os seguintes e imprime MKT_CI_STAGE_FAILED', () => {
  const r = executar(estagiosDeBrinquedo({ 3: { comandos: [marcar(3, 1)] } }));
  assert.equal(r.status, 1);
  assert.deepEqual(r.marcas, [1, 2, 3], 'o 3 falhou: de 4 a 11 não rodam');
  assert.match(r.saida, /MKT_CI_STAGE_FAILED Um estágio do pipeline falhou; a entrega está bloqueada\./);
  assert.deepEqual(r.relatorio.estagios.map((e) => e.status), ['VERDE', 'VERDE', 'VERMELHO', ...Array(8).fill('NAO_RODOU')]);
  assert.equal(r.relatorio.estagios[2].codigo, 'MKT_CI_STAGE_FAILED');
  assert.equal(r.relatorio.resultado, 'VERMELHO');
});

test('ci_estagios_1_a_11_em_todo_push_e_12_a_14_em_entrega: sem opção rodam 1 a 11; com --entrega rodam 12 a 14', () => {
  const push = executar(estagiosDeBrinquedo());
  assert.equal(push.status, 0);
  assert.deepEqual(push.marcas, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(push.relatorio.modo, 'push');
  const entrega = executar(estagiosDeBrinquedo(), ['--entrega']);
  assert.equal(entrega.status, 0);
  assert.deepEqual(entrega.marcas, [12, 13, 14]);
  assert.equal(entrega.relatorio.modo, 'entrega');
  const vermelhoNoDev = executar(estagiosDeBrinquedo({ 12: { comandos: [marcar(12, 1)] } }), ['--entrega']);
  assert.deepEqual(vermelhoNoDev.marcas, [12], 'DEV vermelho: LAB e failure drills não rodam');
  assert.equal(vermelhoNoDev.status, 1);
});

test('estagios_com_arquivos_de_teste_reais: cada estágio de 1 a 13 acha arquivos de teste nos padrões e todos os testes exigidos aparecem neles', () => {
  for (const e of lerEstagios().filter((x) => x.numero <= 13 && x.numero !== 3)) {
    const comandos = E.comandosDaEtapa(e);
    assert.ok(comandos.length > 0, `estágio ${e.numero} sem comando`);
    assert.deepEqual(E.testesExigidosAusentes(e), [], `estágio ${e.numero}: teste exigido ausente`);
  }
  const exigidos = lerEstagios().flatMap((e) => e.exigidos || []);
  for (const nome of ['adv_01_opt_out_recebe_automacao_bloqueado', 'adv_02_mesmo_evento_2x_uma_mensagem_ou_post', 'adv_03_imovel_sem_dado_ia_nao_inventa', 'adv_04_ocorrencia_interna_nao_entra_em_conteudo',
    'adv_05_template_muda_apos_approval_invalida', 'adv_06_frequency_cap_excedido_bloqueia', 'adv_07_kill_switch_ativo_nenhuma_acao_outbound', 'adv_08_provider_timeout_nao_duplica_post',
    'guard_no_hardcoded_cadence', 'guard_send_requires_cansend', 'guard_ai_output_requires_factual_validation', 'guard_public_payload_only', 'guard_no_blind_retry', 'guard_kill_switch_always_checked',
    'guard_review_after_case_resolved', 'guard_replay_is_safe']) assert.ok(exigidos.includes(nome), `${nome} é exigido por algum estágio`);
});

test('esteira_fica_vermelha_ao_remover_um_teste_de_uma_suite: sem o adv_08 na cópia, o estágio 8 reprova antes de rodar qualquer comando', () => {
  const copia = arvore.criarCopia();
  try {
    fs.rmSync(path.join(copia, 'test', 'marco9', 'marketing', 'adversarial', 'adv_08_provider_timeout_nao_duplica_post.test.js'));
    const r = require('node:child_process').spawnSync('node', ['scripts/marketing/ci/executar.js', '--de', '8', '--ate', '8'], { cwd: copia, encoding: 'utf8', env: { ...process.env, DISPOSABLE_DB: '1' } });
    const saida = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1);
    assert.match(saida, /TESTE EXIGIDO AUSENTE: adv_08_provider_timeout_nao_duplica_post/);
    assert.match(saida, /MKT_CI_STAGE_FAILED Um estágio do pipeline falhou; a entrega está bloqueada\. \(estágio 8: provider contract tests\)/);
    console.log(saida.split('\n').filter((l) => /TESTE EXIGIDO|MKT_CI_STAGE_FAILED|# estágio/.test(l)).join('\n'));
  } finally { arvore.remover(copia); }
});

test('estagio_14_sem_arquivo_de_drill_nao_fica_verde_em_silencio: padrão sem arquivo é esteira recusada', () => {
  const e = { numero: 14, nome: 'failure drills', tipo: 'entrega', comandos: [{ testes: ['test/marco9/marketing/drills_que_nao_existem/*.test.js'] }] };
  assert.throws(() => E.comandosDaEtapa(e), /nenhum arquivo de teste/);
});
