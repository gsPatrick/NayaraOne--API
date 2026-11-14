'use strict';

// Livro do Marco 3 §16 ("Gera descrição de imóvel usando apenas dados do cadastro"; "Não afirma característica ausente nem inventa
// metragem"), Guia §12 (buildPropertyPrompt com fatos públicos aprovados + validateGeneratedDescription) e §19 CRM-TS-011 ("AI hallucination
// — Campo ausente — Descrição não inventa"), pelo app real: caminho de regra e caminho de MODELO simulado (provider sandbox devolve o que o
// teste manda, inclusive metragem e característica inventadas).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP } = require('./marco9/_helpers/aiHttpEnv');
const N = require('./helpers/nayComercialHttpEnv');

let env; let tenant;
const MODELO = 'ia.comercial.redacao_por_modelo';
const ctxImovel = (p) => ({ entityType: 'property', entityId: p.id });

before(async () => {
  if (!DISPOSABLE) return;
  ({ env, tenant } = await N.subir(Number(process.env.M3CB_IA_HTTP2_TEST_PORT) || 34301));
});
after(async () => { if (env) await N.encerrar(env, [MODELO]); });

test('CRM-TS-011 AI hallucination: campo ausente, a descrição não inventa (só fatos públicos aprovados, guarda aprova)', { skip: SKIP }, async () => {
  const p = await N.imovel(tenant, { description: 'Observação interna: o proprietário aceita 10% de desconto.' });
  const antes = (await N.admin('SELECT publication_status, description_public, updated_at FROM real_estate.properties WHERE id = $1', [p.id])).rows[0];
  const res = await N.pedir(env, 'A:checker', 'rascunhar_descricao_imovel', 'Escreva a descrição do imóvel', ctxImovel(p));
  N.evidencia('CRM-TS-011-descricao-regra', { taskType: 'rascunhar_descricao_imovel', imovel: 'area 120, Curitiba, R$ 750.000; sem quartos/vagas; observação interna no cadastro' }, res);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.routingPath, 'RULE');
  assert.match(d.answer, /^RASCUNHO/);
  assert.match(d.answer, /área total: 120 m²/);
  assert.match(d.answer, /cidade: Curitiba/);
  assert.match(d.answer, /preço: R\$ 750\.000,00/);
  for (const ausente of ['quartos', 'banheiros', 'vagas', 'piscina', 'suíte', 'desconto', 'Observação interna']) assert.ok(!d.answer.includes(ausente), `não inventa nem vaza: ${ausente}`);
  assert.equal(d.structured.fonte, 'FATOS_PUBLICOS_APROVADOS');
  assert.deepEqual(d.structured.guardaDescricao, { aprovada: true, violacoes: [] });
  assert.equal(d.sources[0].title, 'properties');
  const depois = (await N.admin('SELECT publication_status, description_public, updated_at FROM real_estate.properties WHERE id = $1', [p.id])).rows[0];
  assert.deepEqual(depois, antes, 'nada foi gravado nem publicado');
});

test('CRM-TS-011 CAD-16 pelo caminho de MODELO: o modelo simulado inventa metragem e piscina e a guarda remove (validateGeneratedDescription)', { skip: SKIP }, async () => {
  assert.equal((await N.setParam(env, MODELO, true)).status, 200);
  try {
    const p = await N.imovel(tenant, { bedrooms: 3 });
    const inventada = 'Casa com 3 quartos em Curitiba [1]. São 250 m² de área construída [1]. Tem piscina e churrasqueira [1].';
    const res = await N.pedir(env, 'A:checker', 'rascunhar_descricao_imovel', `Descreva o imóvel [[RESPOSTA:${inventada}]]`, ctxImovel(p));
    N.evidencia('CRM-TS-011-descricao-modelo-simulado', { taskType: 'rascunhar_descricao_imovel', modeloSimuladoDevolve: inventada }, res);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.notEqual(d.routingPath, 'RULE', 'redigido pelo modelo');
    assert.match(d.answer, /^RASCUNHO/);
    assert.match(d.answer, /Casa com 3 quartos em Curitiba/, 'o que está nos fatos fica');
    assert.ok(!/250/.test(d.answer), 'metragem inventada sai');
    assert.ok(!/piscina|churrasqueira/i.test(d.answer), 'característica ausente sai');
    assert.match(d.answer, /A guarda da descrição tirou o que afirmava algo fora dos fatos públicos aprovados/);
    assert.equal(d.structured.guardaDescricao.violacoes.length >= 2, true);
    const tipos = d.structured.guardaDescricao.violacoes.map((v) => v.tipo);
    assert.ok(tipos.includes('METRAGEM_INVENTADA') && tipos.includes('CARACTERISTICA_AUSENTE'), JSON.stringify(tipos));
    assert.equal(d.structured.redigidoPor, 'MODELO');
    // O modelo recebeu só os fatos públicos aprovados (a fonte gravada do run).
    const fontes = (await N.admin('SELECT excerpt FROM ai.ai_sources WHERE ai_run_id = $1', [d.runId])).rows.map((r) => r.excerpt);
    assert.ok(fontes.some((t) => /^Fatos públicos aprovados do imóvel IMV-/.test(t)), JSON.stringify(fontes));
    // Tudo inventado: a resposta vira o texto montado pelo código só com os fatos.
    const tudo = await N.pedir(env, 'A:checker', 'rascunhar_descricao_imovel', 'Descreva o imóvel [[RESPOSTA:Mansão de 900 m² com vista para o mar [1].]]', ctxImovel(p));
    assert.equal(tudo.status, 200, JSON.stringify(tudo.body));
    assert.ok(!/900|vista para o mar/.test(tudo.body.data.answer));
    assert.match(tudo.body.data.answer, /área total: 120 m²/);
    assert.equal(tudo.body.data.structured.guardaDescricao.substituidaPeloTextoDosFatos, true);
  } finally {
    await N.setParam(env, MODELO, false);
  }
});

test('CAD-16 a descrição não usa campo interno: só a visão pública aprovada entra (endereço restrito, sem nome de proprietário)', { skip: SKIP }, async () => {
  const p = await N.imovel(tenant, { parkingSpots: 2, attributesJson: { pool: true, internalNote: 'chave com o zelador' } });
  const res = await N.pedir(env, 'A:checker', 'rascunhar_descricao_imovel', 'Escreva a descrição do imóvel', ctxImovel(p));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.answer, /vagas: 2/);
  assert.match(res.body.data.answer, /características: piscina/, 'característica pública do cadastro entra');
  assert.ok(!/zelador/.test(res.body.data.answer), 'atributo interno não entra');
});
