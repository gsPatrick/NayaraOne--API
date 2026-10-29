'use strict';

// M9-D025 — GroundingValidator: fontes e snapshot em toda resposta factual, insuficiência, citações, confiança como sinal e
// divergência. Função pura (sem banco): usa o provider sandbox roteirizado dos helpers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateGrounding, constants } = require('../../../src/features/ai/orchestrator/grounding');
const { AGORA, fonteContrato, fonteReadModel, modeloSandbox } = require('../_helpers/m9d025Fixtures');

const INSUF = 'Não tenho informações suficientes nas fontes autorizadas para responder isso com segurança.';

test('m9d025_sem_fonte_insuficiencia', async () => {
  const modelo = modeloSandbox(['O saldo do contrato X é R$ 5.000,00.']);
  const texto = await modelo({ attempt: 1 });
  const r = validateGrounding({ answerText: texto, taskType: 'consulta', sources: [] }, {});
  assert.equal(r.groundingStatus, 'INSUFFICIENT_SOURCES');
  assert.ok(r.answer.startsWith(INSUF), r.answer);
  assert.ok(!r.answer.includes('5.000'), 'a insuficiência não repete o valor inventado');
  assert.deepEqual(r.sources, []);
  // fonte que existe mas está abaixo da relevância mínima também não basta (parâmetro ia.grounding.relevancia_minima)
  const fraca = validateGrounding({ answerText: 'O contrato vence em 30/11/2026 [1].', taskType: 'consulta', sources: [fonteContrato({ relevanceScore: 0.3 })] }, {});
  assert.equal(fraca.groundingStatus, 'INSUFFICIENT_SOURCES');
  assert.match(fraca.answer, /Fontes consultadas: Contrato de locação 123/);
  const aceita = validateGrounding({ answerText: 'O contrato vence em 30/11/2026 [1].', taskType: 'consulta', sources: [fonteContrato({ relevanceScore: 0.3 })] }, { relevanciaMinima: 0.2 });
  assert.equal(aceita.groundingStatus, 'GROUNDED');
});

test('adv_rag_sem_fonte_suficiente_resposta_de_insuficiencia', async () => {
  // o RAG devolveu um trecho irrelevante, revogado e outro de outro assunto: nenhum sustenta a resposta
  const fontes = [
    fonteContrato({ relevanceScore: 0.1 }),
    fonteContrato({ statusAtRetrieval: 'REVOGADA', relevanceScore: 0.95 }),
    fonteContrato({ usedInAnswer: false, relevanceScore: 0.95 }),
    fonteContrato({ sourceType: 'DOCUMENT_CHUNK', relevanceScore: null }),
  ];
  const r = validateGrounding({ answerText: 'A multa do contrato é de R$ 1.500,00 [1].', taskType: 'consulta', sources: fontes }, {});
  assert.equal(r.groundingStatus, 'INSUFFICIENT_SOURCES');
  assert.ok(r.answer.startsWith(INSUF));
  assert.ok(!/1\.500/.test(r.answer));
  assert.equal(r.snapshotAt, null);
});

test('m9d025_resposta_factual_exige_fonte_e_snapshot', async () => {
  const r = validateGrounding({ answerText: 'O saldo é R$ 18.432,50 em 7 parcelas [1].', taskType: 'consulta', sources: [fonteReadModel()] }, {});
  assert.equal(r.factual, true);
  assert.equal(r.groundingStatus, 'GROUNDED');
  assert.equal(r.sources.length, 1);
  const f = r.sources[0];
  assert.deepEqual(Object.keys(f).sort(), ['classification', 'clause', 'excerpt', 'ref', 'retrievedAt', 'title', 'type', 'validity', 'version'].sort());
  assert.equal(f.ref, 1);
  assert.equal(f.type, 'READ_MODEL');
  assert.equal(f.classification, 'INTERNAL');
  assert.ok(r.snapshotAt && r.snapshotAtLocal, 'toda resposta factual traz o carimbo do dado');
  // contrato: versão e vigência acompanham a fonte
  const c = validateGrounding({ answerText: 'A multa é de R$ 1.500,00 [1].', taskType: 'consulta', sources: [fonteContrato()] }, {});
  assert.equal(c.sources[0].version, '3');
  assert.equal(c.sources[0].validity.from, '2026-01-01T00:00:00.000Z');
  // snapshot informado pelo read model vence a hora da leitura
  const s = validateGrounding({ answerText: 'O saldo é R$ 18.432,50 [1].', taskType: 'consulta', sources: [fonteReadModel()], snapshotAt: '2026-10-26T12:00:00.000Z' }, {});
  assert.equal(s.snapshotAt, '2026-10-26T12:00:00.000Z');
  // conversa pura não é factual
  const conversa = validateGrounding({ answerText: 'Olá! Posso ajudar com mais alguma coisa?', taskType: 'conversa', sources: [] }, {});
  assert.equal(conversa.groundingStatus, 'NOT_APPLICABLE');
  assert.equal(conversa.factual, false);
  // tarefa de conversa que afirma número vira factual pelo verificador de entidades
  const disfarce = validateGrounding({ answerText: 'O saldo é R$ 99,00.', taskType: 'conversa', sources: [] }, {});
  assert.equal(disfarce.groundingStatus, 'INSUFFICIENT_SOURCES');
});

test('m9d025_afirmacao_sem_marcador_removida', async () => {
  const texto = 'A multa é de R$ 1.500,00 [1]. O aluguel é de R$ 3.200,00. O contrato vence em 30/11/2026 [1].';
  const r = validateGrounding({ answerText: texto, taskType: 'consulta', sources: [fonteContrato()] }, {});
  assert.equal(r.groundingStatus, 'GROUNDED');
  assert.ok(!/3\.200/.test(r.answer), 'afirmação sem marcador sai da resposta');
  assert.match(r.answer, /1\.500,00 \[1\]/);
  assert.match(r.answer, /30\/11\/2026 \[1\]/);
  assert.equal(r.removedClaims, 1);
  // marcador que aponta para fonte inexistente ou valor que a fonte citada não contém também saem
  const r2 = validateGrounding({ answerText: 'A multa é de R$ 1.500,00 [1]. O contrato vence em 31/12/2026 [1]. O prazo é 10/10/2026 [7].', taskType: 'consulta', sources: [fonteContrato()] }, {});
  assert.ok(!/31\/12/.test(r2.answer) && !/10\/10/.test(r2.answer));
  assert.equal(r2.removedClaims, 2);
  // sobrou nada: a resposta inteira vira insuficiência
  const r3 = validateGrounding({ answerText: 'O aluguel é de R$ 3.200,00.', taskType: 'consulta', sources: [fonteContrato()] }, {});
  assert.equal(r3.groundingStatus, 'INSUFFICIENT_SOURCES');
  assert.ok(r3.answer.startsWith(INSUF));
});

test('m9d025_resposta_factual_sem_fonte_bloqueada_422_quando_configurado', async () => {
  const input = { answerText: 'O aluguel é de R$ 3.200,00.', taskType: 'consulta', sources: [] };
  assert.throws(() => validateGrounding(input, { bloquearSemFonte: true }), (e) => e.statusCode === 422 && e.code === 'AI_UNGROUNDED_FACT'
    && e.message === 'A resposta foi bloqueada porque não cita fontes internas.');
  assert.equal(validateGrounding(input, { bloquearSemFonte: false }).groundingStatus, 'INSUFFICIENT_SOURCES');
});

test('m9d025_nao_completa_lacuna_com_conhecimento_do_modelo', async () => {
  // a fonte tem a multa, mas o modelo completa com a data de reajuste e um índice que ninguém forneceu
  const texto = 'A multa é de R$ 1.500,00 [1]. O reajuste é anual pelo IGP-M de 4,5% [1]. Segundo a lei, o prazo é de 30 dias [1].';
  const r = validateGrounding({ answerText: texto, taskType: 'consulta', sources: [fonteContrato()] }, {});
  assert.match(r.answer, /1\.500,00/);
  assert.ok(!/4,5/.test(r.answer) && !/30 dias/.test(r.answer), 'o que a fonte citada não contém não fica, mesmo com marcador');
  assert.equal(r.removedClaims, 2);
  // pergunta cuja resposta não está na fonte: nada é "estimado" nem arredondado
  const sem = validateGrounding({ answerText: 'Aproximadamente R$ 5 mil [1].', taskType: 'consulta', sources: [fonteContrato()] }, {});
  assert.equal(sem.groundingStatus, 'INSUFFICIENT_SOURCES');
});

test('m9d025_confidence_nao_libera_acao', async () => {
  const base = { answerText: 'O contrato vence em 30/11/2026 [1].', taskType: 'consulta', critical: true };
  const alta = validateGrounding({ ...base, sources: [fonteContrato({ relevanceScore: 1 })] }, {});
  const baixa = validateGrounding({ ...base, sources: [fonteContrato({ relevanceScore: 0.55 })] }, {});
  assert.notEqual(alta.confidence, baixa.confidence, 'a confiança varia com a relevância');
  assert.match(alta.confidenceLabel, /^confiança estimada: \d,\d{4}$/);
  // confiança máxima não dispensa nada: confirmação humana, fonte e status são idênticos
  for (const r of [alta, baixa]) {
    assert.equal(r.requiresHumanConfirmation, true);
    assert.equal(r.groundingStatus, 'GROUNDED');
    assert.match(r.answer, /Confirmação humana necessária antes de agir\./);
  }
  // cálculo determinístico: 0,6 x 1 + 0,4 x 1 = 1
  assert.equal(alta.confidence, '1.0000');
  const peso = validateGrounding({ ...base, sources: [fonteContrato({ relevanceScore: 0.8 })] }, { pesoRelevancia: 0.5 });
  assert.equal(peso.confidence, '0.9000');
  // nenhuma regra do código da NAY decide com base em `confidence`
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..', '..', '..', 'src', 'features', 'ai');
  const achados = [];
  (function varrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (p.endsWith('.js')) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((linha, i) => {
          if (/\b(if|while)\s*\(.*\bconfidence\b|\bconfidence\b\s*(>=?|<=?|===?)\s*[\d.]|\?\s*.*\bconfidence\b.*:/.test(linha) && !/validation|mapper/.test(p)) achados.push(`${p}:${i + 1}`);
        });
      }
    }
  }(raiz));
  assert.deepEqual(achados, [], 'nenhum código decide por confidence');
});

test('m9d025_divergencia_listada_com_versoes', async () => {
  const fontes = [fonteContrato({ version: '3' }), fonteContrato({ version: '2', excerpt: 'Cláusula 4.2: o contrato vence em 31/10/2026.' })];
  const conflicts = [{
    label: 'Vencimento do contrato',
    versions: [
      { ref: 1, title: 'Contrato de locação 123', version: '3', effectiveFrom: '2026-06-01T12:00:00.000Z', value: '30/11/2026' },
      { ref: 2, title: 'Contrato de locação 123', version: '2', effectiveFrom: '2026-01-01T12:00:00.000Z', value: '31/10/2026' },
    ],
  }];
  const r = validateGrounding({ answerText: 'O contrato vence em 30/11/2026 [1].', taskType: 'consulta', sources: fontes, conflicts }, {});
  assert.equal(r.groundingStatus, 'CONFLICTING_SOURCES');
  assert.match(r.answer, /as fontes consultadas divergem/);
  assert.match(r.answer, /versão 3.*30\/11\/2026/);
  assert.match(r.answer, /versão 2.*31\/10\/2026/);
  // sem divergência, sem bloco
  const ok = validateGrounding({ answerText: 'O contrato vence em 30/11/2026 [1].', taskType: 'consulta', sources: [fontes[0]] }, {});
  assert.equal(ok.groundingStatus, 'GROUNDED');
  assert.ok(!/divergem/.test(ok.answer));
});

test('m9d025_snapshot_em_america_sao_paulo', async () => {
  const r = validateGrounding({ answerText: 'O saldo é R$ 18.432,50 [1].', taskType: 'consulta', sources: [fonteReadModel({ retrievedAt: AGORA })], snapshotAt: AGORA }, {});
  assert.equal(r.snapshotAt, '2026-10-27T17:05:00.000Z');
  assert.equal(r.snapshotAtLocal, '27/10/2026 14:05');
  // virada de dia: 02:30 UTC de 28/10 ainda é 27/10 23:30 em São Paulo
  const n = validateGrounding({ answerText: 'O saldo é R$ 18.432,50 [1].', taskType: 'consulta', sources: [fonteReadModel()], snapshotAt: '2026-10-28T02:30:00.000Z' }, {});
  assert.equal(n.snapshotAtLocal, '27/10/2026 23:30');
  assert.equal(constants.FUSO, 'America/Sao_Paulo');
});

test('m9d025_prazo_critico_sem_fonte_exata_responde_orientacao_200', async () => {
  // fonte sem cláusula: não é "fonte exata"
  const r = validateGrounding({ answerText: 'O contrato vence em 30/11/2026 [1].', taskType: 'consulta', sources: [fonteContrato({ clause: null })] }, { bloquearSemFonte: true });
  assert.equal(r.groundingStatus, 'INSUFFICIENT_SOURCES');
  assert.equal(r.answer.split('\n')[0], 'Não tenho a fonte exata deste prazo; consulte o responsável jurídico.');
  assert.equal(r.requiresHumanConfirmation, false);
});
