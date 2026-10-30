'use strict';

// Apoio das guardas "Não improvisar" do Marketing (M9-D440): raiz da API (ou da cópia onde o teste roda), conferência da parte estática, cópia do módulo com a violação injetada e espiões
// no adapter sandbox (quantas vezes o canal foi chamado e em que ordem). Não é teste.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..', '..');
const { rodarTodas, formatar } = require(path.join(RAIZ, 'scripts', 'marketing', 'guards'));
const arvore = require(path.join(RAIZ, 'scripts', 'marketing', 'mutation', 'arvore'));
const { SandboxChannelAdapter } = require('../../../src/features/marketing/publications/adapters/sandbox/SandboxChannelAdapter');

const q = (t, sql, replacements) => require('../../../src/models').sequelize.query(sql, { transaction: t, replacements, type: 'SELECT' });
const violacoesDe = (nome, raiz = RAIZ) => rodarTodas(raiz).find((r) => r.guarda === nome).violacoes;

/** Parte estática da guarda: nenhuma violação no código desta raiz; se houver, o teste mostra a mensagem em português (arquivo, linha e regra). */
function assertSemViolacao(nome, raiz = RAIZ) {
  assert.deepEqual(violacoesDe(nome, raiz).map(formatar), [], `a guarda ${nome} achou violação`);
}

/** Cópia do módulo Marketing (só src/features/marketing) numa pasta temporária; as edições `{ arquivo, de, para } | { arquivo, criar }` usam o caminho a partir da raiz da API. */
function copiaDoModulo(edicoes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-guarda-'));
  fs.cpSync(path.join(RAIZ, 'src', 'features', 'marketing'), path.join(dir, 'src', 'features', 'marketing'), { recursive: true });
  arvore.aplicar(dir, edicoes);
  return dir;
}

/**
 * Espiões no adapter sandbox dos canais: `chamadas` = [{ tipo: 'envio'|'consulta', operacao, canal, chave }] na ordem em que aconteceram. `restaurar()` devolve o original.
 * Toda saída do Marketing em sandbox passa por `execute` (send e publish) e a reconciliação por `findByIdempotencyKey`.
 */
function espiarCanais() {
  const chamadas = [];
  const execute = SandboxChannelAdapter.prototype.execute;
  const consulta = SandboxChannelAdapter.prototype.findByIdempotencyKey;
  SandboxChannelAdapter.prototype.execute = function espiaExecute(operation, payload, options) {
    chamadas.push({ tipo: 'envio', operacao: operation, canal: this.channel, chave: options && options.idempotencyKey });
    return execute.call(this, operation, payload, options);
  };
  SandboxChannelAdapter.prototype.findByIdempotencyKey = function espiaConsulta(key) {
    chamadas.push({ tipo: 'consulta', operacao: 'findByIdempotencyKey', canal: this.channel, chave: key });
    return consulta.call(this, key);
  };
  return {
    chamadas,
    envios: (canal) => chamadas.filter((c) => c.tipo === 'envio' && (!canal || c.canal === canal)),
    restaurar() { SandboxChannelAdapter.prototype.execute = execute; SandboxChannelAdapter.prototype.findByIdempotencyKey = consulta; },
  };
}

module.exports = { q, RAIZ, violacoesDe, assertSemViolacao, copiaDoModulo, espiarCanais, formatar, rodarTodas, arvore };
