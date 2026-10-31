'use strict';

// M9-D444 — portão de sprints e início de demanda fora de ordem (sem banco): estados aberto/em andamento/fechado, runner antes do canSend, execução sem impasse e o script de linha de comando.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../_helpers/mktPortao');
const G = require('../../../scripts/lib/marketingPortao');

const com = (m, id, status) => new Map([...m].map(([i, d]) => [i, i === id ? { ...d, status } : d]));
const avaliar = (demandas) => G.avaliar({ ...K.fontes(demandas), demandas });

test('portao_de_sprint_calcula_aberto_andamento_fechado', () => {
  const f = K.fontes();
  const todosAbertos = G.estadoDosSprints(f.mapa, K.comStatus(f.demandas, 'aberta'));
  assert.deepEqual(todosAbertos.map((s) => s.estado), Array(9).fill('aberto'));
  const m2 = G.estadoDosSprints(f.mapa, K.comStatus(f.demandas, 'aberta', Object.fromEntries(f.mapa.M2.map((id) => [id, 'verificada']))));
  assert.equal(m2[1].estado, 'fechado');
  assert.deepEqual([m2[1].verificadas, m2[1].total], [4, 4]);
  assert.deepEqual(m2.filter((s) => s.codigo !== 'M2').map((s) => s.estado), Array(8).fill('aberto'));
  const andamento = G.estadoDosSprints(f.mapa, K.comStatus(f.demandas, 'verificada', { 'M9-D420': 'em_execucao', 'M9-D421': 'aberta' }));
  assert.equal(andamento[2].estado, 'em andamento');
  assert.deepEqual(andamento[2].motivos, ['M9-D420 está em_execucao', 'M9-D421 está aberta']);
  assert.equal(andamento[0].estado, 'fechado');
  const real = G.estadoDosSprints(f.mapa, f.demandas);
  assert.equal(real.length, 9);
  assert.ok(real.every((s) => ['aberto', 'em andamento', 'fechado'].includes(s.estado)));
});

test('runner_nao_inicia_antes_do_cansend', () => {
  const base = K.todas();
  const bloqueado = avaliar(K.comStatus(base, 'verificada', { 'M9-D414': 'em_execucao', 'M9-D418': 'aberta' }));
  assert.equal(bloqueado.ok, false);
  const e = bloqueado.erros.find((x) => x.id === 'M9-D414');
  assert.equal(e.codigo, 'MKT_SPRINT_START_BLOCKED');
  assert.equal(e.mensagem, 'A demanda não pode começar antes das suas dependências.');
  assert.ok(e.bloqueadoPor.includes('dependência M9-D418 está aberta'));
  // com o canSend (D418) e o kill switch (D425) verificados, a adiantada é permitida
  const permitido = avaliar(K.comStatus(base, 'verificada', { 'M9-D414': 'em_execucao' }));
  assert.deepEqual(permitido.erros, []);
  // kill switch ainda aberto também bloqueia o runner
  const semKill = avaliar(K.comStatus(base, 'verificada', { 'M9-D414': 'em_execucao', 'M9-D425': 'aberta' }));
  assert.ok(semKill.erros.some((x) => x.id === 'M9-D414' && x.bloqueadoPor.includes('dependência M9-D425 está aberta')));
  // sprint anterior aberto (e que não espera adiantada) bloqueia o início de um sprint posterior
  const sprintAberto = avaliar(K.comStatus(base, 'verificada', { 'M9-D416': 'em_execucao', 'M9-D406': 'aberta' }));
  assert.ok(sprintAberto.erros.some((x) => x.id === 'M9-D416' && x.bloqueadoPor.some((b) => /sprint M1 não fechado \(M9-D406\)/.test(b))));
});

test('ordem_de_execucao_existe_sem_impasse_com_as_adiantadas', () => {
  // simula o projeto do zero: o bloco todo aberto; a cada passo inicia (e verifica) a primeira demanda que o portão deixa começar. As 12 adiantadas não podem travar a ordem.
  let atual = K.comStatus(K.todas(), 'aberta');
  const feitas = [];
  for (let volta = 0; volta < 60; volta += 1) {
    const abertas = [...atual.keys()].filter((id) => atual.get(id).status === 'aberta' && Number(id.slice(4)) >= 400 && Number(id.slice(4)) <= 444).sort();
    if (!abertas.length) break;
    const livre = abertas.find((id) => !avaliar(com(atual, id, 'em_execucao')).erros.some((e) => e.codigo === 'MKT_SPRINT_START_BLOCKED' && e.id === id));
    assert.ok(livre, `impasse: nenhuma demanda pode começar (abertas: ${abertas.join(', ')})`);
    feitas.push(livre);
    atual = com(atual, livre, 'verificada');
  }
  assert.equal(feitas.length, 44);
  assert.ok(feitas.indexOf('M9-D425') < feitas.indexOf('M9-D408'), 'o kill switch vem antes de autopublicar');
  assert.ok(feitas.indexOf('M9-D418') < feitas.indexOf('M9-D414'), 'o canSend vem antes do runner');
  assert.ok(feitas.indexOf('M9-D430') < feitas.indexOf('M9-D410'), 'o contrato do adapter vem antes do worker de publicação');
});

test('script_imprime_9_sprints_11_passos_44_demandas_e_12_adiantadas', () => {
  const c = K.copiarDemandas(); // estado do portão fixado na cópia: independe do andamento real das demandas
  try {
    const r = K.rodar(c.raiz);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /44 demandas, 9 sprints, 11 passos, 12 dependências adiantadas/);
    assert.equal((r.stdout.match(/^M[1-9] /gm) || []).length, 9);
    assert.equal((r.stdout.match(/^passo \d+ /gm) || []).length, 11);
    assert.equal((r.stdout.match(/^adiantada /gm) || []).length, 12);
    const json = JSON.parse(K.rodar(c.raiz, ['--json']).stdout);
    assert.equal(json.ok, true);
    assert.equal(json.total, 44);
  } finally { c.limpar(); }
});

test('script_reprova_aresta_inventada_demanda_fora_do_mapa_e_inicio_fora_de_ordem', () => {
  const c = K.copiarDemandas();
  try {
    K.editar(c, 'M9-D416', '| Dependências | M9-D413; M9-D417 |', '| Dependências | M9-D413; M9-D417; M9-D429 |');
    const aresta = K.rodar(c.raiz);
    assert.equal(aresta.status, 1);
    assert.match(aresta.stderr, /MKT_SPRINT_ORDER_VIOLATION: A dependência aponta para um sprint ou passo posterior\. M9-D416 -> M9-D429/);
    K.editar(c, 'M9-D416', '; M9-D429 |', ' |');
    assert.equal(K.rodar(c.raiz).status, 0);
    K.editar(c, 'M9-D414', '| Status | verificada |', '| Status | em_execucao |');
    K.editar(c, 'M9-D418', '| Status | verificada |', '| Status | aberta |');
    const inicio = K.rodar(c.raiz);
    assert.equal(inicio.status, 1);
    assert.match(inicio.stderr, /MKT_SPRINT_START_BLOCKED: A demanda não pode começar antes das suas dependências\. M9-D414/);
    assert.match(inicio.stderr, /dependência M9-D418 está aberta/);
    K.editar(c, 'M9-D414', '| Status | em_execucao |', '| Status | verificada |');
    K.editar(c, 'M9-D418', '| Status | aberta |', '| Status | verificada |');
    K.editar(c, 'M9-D439', ', D440, D441', ', D441');
    const mapa = K.rodar(c.raiz);
    assert.equal(mapa.status, 1);
    assert.match(mapa.stderr, /MKT_SPRINT_MAP_INVALID: A demanda não está em exatamente um sprint\. M9-D440 \(sem sprint\)/);
  } finally { c.limpar(); }
});

test('script_sem_pasta_de_demandas_so_passa_com_demandas_opcional', () => {
  const sem = K.rodar('/nao/existe/m9d444');
  assert.equal(sem.status, 1);
  assert.match(sem.stderr, /pasta de demandas não encontrada/);
  const opcional = K.rodar('/nao/existe/m9d444', ['--demandas-opcional']);
  assert.equal(opcional.status, 0);
  assert.match(opcional.stdout, /portão de sprints do Marketing não conferido/);
});
