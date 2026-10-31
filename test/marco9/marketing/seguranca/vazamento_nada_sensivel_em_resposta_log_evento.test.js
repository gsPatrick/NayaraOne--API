'use strict';

// M9-D441 segurança 2 (Caderno §14): nenhuma resposta, log ou evento contém endereço de contato (telefone e e-mail), token ou texto integral de mensagem. Cenário: mensagem automática a uma
// pessoa com telefone e e-mail conhecidos e publicação cujo provedor devolve erro com token e e-mail no texto. Varre o que o sistema DEVOLVE (conteúdo, publicações, atribuição, run), o que
// EMITE (eventos do outbox, logs em nível debug) e o que GRAVA (resultados, jobs, runs, versões, auditoria). A mensagem enviada existe só no CRM. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const worker = require('../../_helpers/mktWorker');
const { cenario } = require('../../_helpers/mktSegCenario');

let ctx;
before(async () => { ctx = await worker.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { worker.reset(); worker.resetSandbox(); });

const sozinhos = (texto, valor) => texto.split(valor).length - 1;

test('vazamento_nada_sensivel_em_resposta_log_evento', async (tctx) => {
  await withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const c = await cenario(t, ctx);
    assert.equal(c.mensagens, 1, 'a mensagem automática saiu (o cenário não é vazio)');
    assert.ok(c.logs.length > 500, 'o log foi capturado');
    assert.ok(c.respostas.length > 500 && c.eventos.length > 100 && c.registros.length > 500, 'as superfícies não estão vazias');
    const procurados = {
      'telefone': c.secrets.telefone, 'telefone sem o DDD': c.secrets.telefone.slice(2), 'e-mail': c.secrets.email, 'token': c.secrets.token, 'bearer': c.secrets.bearer,
      'texto integral da mensagem': c.secrets.mensagem, 'rua do imóvel': c.secrets.rua, 'CEP': c.secrets.cep,
    };
    const superficies = { 'resposta (DTO)': c.respostas, 'evento do outbox': c.eventos, 'log': c.logs, 'registro gravado': c.registros };
    const achados = [];
    for (const [rotulo, texto] of Object.entries(superficies)) {
      for (const [nome, valor] of Object.entries(procurados)) if (texto.includes(valor)) achados.push(`${nome} em ${rotulo} (${sozinhos(texto, valor)}x)`);
    }
    assert.deepEqual(achados, [], `vazamento: ${achados.join('; ')}`);
    tctx.diagnostic(`4 superfícies varridas (${c.respostas.length} + ${c.eventos.length} + ${c.logs.length} + ${c.registros.length} caracteres) contra 8 valores sensíveis: nenhum achado`);
  });
});
