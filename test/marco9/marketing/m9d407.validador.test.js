'use strict';

// M9-D407 — validador factual determinístico: texto x PublicPropertyReadModel (preço, área, quartos/suítes/banheiros/vagas,
// endereço, características e número inexplicável). Função pura: não toca em banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateAgainstFacts } = require('../../../src/features/marketing/content/factualValidator');
const { FACTS, withFacts, withoutFacts, kinds, first } = require('../_helpers/mktFactual');

const v = (text, facts = FACTS, options) => validateAgainstFacts(text, facts, options);

test('texto_fiel_ao_cadastro_passa_e_adjetivo_subjetivo_tambem', () => {
  const ok = v('Casa linda na Pituba, Salvador, com 3 quartos (1 suíte), 2 banheiros, 2 vagas, 120 m² de área útil, piscina e churrasqueira por R$ 780.000.');
  assert.deepEqual(ok, { ok: true, findings: [] });
  assert.equal(v('Um sonho de casa, aconchegante e maravilhosa, com a melhor vista.').ok, true);
});

test('quartos_divergentes_bloqueiam', () => {
  const r = v('Casa de 4 quartos na Pituba.');
  assert.equal(r.ok, false);
  assert.deepEqual(first(r, 'ROOMS'), { kind: 'ROOMS', claim: '4 quartos', expected: 3, found: 4, severity: 'BLOCK', reason: 'MISMATCH', message: first(r, 'ROOMS').message });
  assert.match(first(r, 'ROOMS').message, /quartos/);
  assert.equal(v('Casa de dois quartos.').findings[0].found, 2, 'número por extenso (pt-BR) também é lido');
  assert.equal(v('Casa de três quartos e uma suíte.').ok, true);
  assert.equal(first(v('Casa com 2 suítes.'), 'ROOMS').expected, 1);
  assert.equal(first(v('Casa com 5 banheiros.'), 'ROOMS').expected, 2);
});

test('vagas_divergentes_bloqueiam_como_numero', () => {
  const r = v('Casa com 3 vagas de garagem.');
  assert.deepEqual(kinds(r), ['NUMBER']);
  assert.equal(r.findings[0].expected, 2);
});

test('preco_em_k_e_normalizado', () => {
  for (const text of ['Por R$ 780k.', 'Por R$780k.', 'Por 780 mil.', 'Por R$ 780.000,00.', 'Por R$ 780 mil.', 'Por R$ 780.000.']) {
    assert.equal(v(text).ok, true, text);
  }
  assert.equal(v('Por R$ 0,78 milhão.').ok, true);
  const r = v('Por R$ 781k.');
  assert.deepEqual(kinds(r), ['PRICE']);
  assert.equal(r.findings[0].expected[0], 780000);
  assert.equal(r.findings[0].found, 781000);
  assert.equal(v('Por R$ 779.999,99.').ok, false, 'tolerância 0: nem um centavo de diferença');
  assert.equal(v('Por R$ 1.').ok, false);
});

test('area_confere_com_tolerancia_lida_do_parametro', () => {
  assert.equal(v('Casa com 120 m².').ok, true);
  assert.equal(v('Casa com 120m2 e terreno de 200 metros quadrados.').ok, true);
  const r = v('Casa com 125 m².');
  assert.deepEqual(kinds(r), ['AREA']);
  assert.equal(v('Casa com 125 m².', FACTS, { toleranciaAreaM2: 5 }).ok, true);
  assert.equal(v('Casa com 126 m².', FACTS, { toleranciaAreaM2: 5 }).ok, false);
});

test('imovel_sem_dado_ia_nao_inventa', () => {
  const area = v('Casa com 120 m².', withoutFacts('areaUtilM2', 'areaTotalM2'));
  assert.equal(area.ok, false);
  assert.equal(area.findings[0].kind, 'AREA');
  assert.equal(area.findings[0].reason, 'MISSING');
  assert.equal(area.findings[0].expected, null);
  assert.match(area.findings[0].message, /dado inexistente, a IA não inventa/);
  assert.equal(v('Casa com 2 vagas.', withoutFacts('vagas')).findings[0].reason, 'MISSING');
  assert.equal(v('Casa com piscina.', withoutFacts('features')).findings[0].kind, 'FEATURE');
  assert.equal(v('Casa por R$ 780 mil.', withoutFacts('precoVenda')).findings[0].reason, 'MISSING');
  assert.equal(v('Casa com 3 quartos por R$ 780 mil.', {}).findings.length, 2, 'sem nenhum fato, tudo que o texto afirma é bloqueado');
});

test('feature_inventada_bloqueia_e_sinonimo_do_dicionario_vale', () => {
  const r = v('Casa com elevador e academia.');
  assert.deepEqual(kinds(r), ['FEATURE', 'FEATURE']);
  assert.deepEqual(r.findings.map((f) => f.claim).sort(), ['academia', 'elevador']);
  assert.equal(v('Casa com sacada e área de churrasco.', withFacts({ features: ['varanda', 'churrasqueira'] })).ok, true, 'sacada = varanda; "área de churrasco" não está no dicionário');
  assert.equal(v('Casa com sacada.').ok, true);
  assert.equal(v('Casa sem elevador.').ok, true, 'negar o que não existe é verdade');
  assert.equal(v('Casa sem piscina.').ok, false, 'negar o que existe contradiz o cadastro');
  assert.equal(v('Casa com Piscina e CHURRASQUEIRA!').ok, true, 'sem diferença de caixa nem de acento');
  const custom = new Map([['elevador', ['elevador', 'ascensor']]]);
  assert.equal(v('Casa com ascensor.', withFacts({ features: ['elevador'] }), { featureGroups: custom }).ok, true);
});

test('endereco_fora_da_politica_bloqueia', () => {
  const r = v('Casa na Rua das Acácias, 120, Pituba.');
  assert.deepEqual(kinds(r), ['ADDRESS']);
  assert.equal(r.findings[0].claim, 'Rua das Acácias, 120');
  assert.equal(r.findings[0].expected, null);
  assert.equal(v('Casa na Rua das Acácias.').findings[0].kind, 'ADDRESS');
  assert.equal(v('Casa na Avenida Paulista.').ok, false);
  assert.equal(v('CEP 01310-100.').findings[0].kind, 'ADDRESS');
  const comRua = withFacts({ logradouro: 'Rua das Acácias', numeroEndereco: '120' });
  assert.equal(v('Casa na Rua das Acácias, 120, Pituba.', comRua).ok, true);
  assert.equal(v('Casa na Rua das Acácias.', comRua).ok, true);
  assert.equal(v('Casa na Rua das Acácias, 121.', comRua).findings[0].found, '121');
  assert.equal(v('Casa na Rua dos Ipês.', comRua).ok, false);
  const semNumero = withFacts({ logradouro: 'Rua das Acácias' });
  assert.equal(v('Casa na Rua das Acácias, 120.', semNumero).ok, false, 'RUA_SEM_NUMERO: o número não pode aparecer');
  assert.equal(v('Casa no bairro Pituba.').ok, true);
  assert.equal(v('Casa no bairro Barra.').ok, false);
  assert.equal(v('Casa no bairro Pituba.', withoutFacts('bairro')).ok, false, 'OCULTO: sem bairro no cadastro, não cita bairro');
});

test('numero_desconhecido_bloqueia', () => {
  for (const text of ['A 5 minutos do metrô.', 'A cinco minutos do metrô.', 'Condomínio com 12 andares.', 'Ligue para 71 99999-0000.']) {
    const r = v(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.findings[0].kind, 'UNKNOWN_CLAIM', text);
    assert.equal(r.findings[0].severity, 'BLOCK');
  }
  assert.equal(first(v('Entrega em 15 dias.'), 'UNKNOWN_CLAIM').claim, '15');
  assert.equal(first(v('Fale com Ana, CPF 123.456.789-09.'), 'UNKNOWN_CLAIM').kind, 'UNKNOWN_CLAIM', 'documento de pessoa não é fato do imóvel');
});

test('numeros_explicaveis_nao_bloqueiam_ano_telefone_da_empresa_e_data_do_conteudo', () => {
  assert.equal(v('Construída em 2019.').ok, true);
  assert.equal(v('Ligue (71) 3333-4444.', FACTS, { telefonesEmpresa: ['7133334444'] }).ok, true);
  assert.equal(v('Ligue (71) 3333-4444.').ok, false, 'sem o telefone cadastrado da empresa, é número inexplicável');
  const options = { contentDate: new Date('2026-11-09T15:00:00Z') };
  assert.equal(v('Publicado em 09/11/2026.', FACTS, options).ok, true);
  assert.equal(v('Publicado em 9 de novembro.', FACTS, options).ok, true);
  assert.equal(v('Visitas até 20/11/2026.', FACTS, options).ok, false);
  assert.equal(v('Casa de portaria 24h.', withFacts({ features: ['portaria 24h'] })).ok, true, '"24h" pertence à característica');
});

test('superlativo_verificavel_bloqueia_e_adjetivo_subjetivo_passa', () => {
  for (const text of ['O maior do bairro.', 'A melhor casa da região.', 'O único imóvel com varanda do bairro.', 'O mais barato da cidade.']) {
    const r = v(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.findings[0].kind, 'UNKNOWN_CLAIM', text);
  }
  assert.equal(v('A casa mais linda e a melhor vista.').ok, true);
});

test('validador_e_deterministico_nao_muta_a_entrada_e_nao_usa_ia', () => {
  const facts = JSON.parse(JSON.stringify(FACTS));
  const text = 'Casa de 4 quartos por R$ 800k, elevador e 130 m², Rua Verde, 12.';
  const a = v(text, facts);
  assert.deepEqual(v(text, facts), a);
  assert.deepEqual(facts, FACTS);
  const dir = path.join(__dirname, '../../../src/features/marketing/content');
  const files = [path.join(dir, 'factualValidator.js'), ...fs.readdirSync(path.join(dir, 'factual')).map((f) => path.join(dir, 'factual', f))];
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(code, /require\([^)]*(?:\/ai|nayPort|providers|anthropic|openai|fetch|axios|http)/i, path.basename(file));
    assert.doesNotMatch(code, /Math\.random|Date\.now|new Date\(\)/, `${path.basename(file)}: sem relógio nem aleatório`);
  }
});

test('entrada_invalida_nao_quebra_e_texto_vazio_passa', () => {
  assert.deepEqual(v('', FACTS), { ok: true, findings: [] });
  assert.equal(v(undefined, null).ok, true);
  assert.equal(v('Casa de 3 quartos.', null).ok, false);
});
