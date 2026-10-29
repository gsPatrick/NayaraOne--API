'use strict';

// M9-D830 — conteúdo dos seis runbooks setoriais (docs/runbooks/bcp): arquivos do catálogo, os 7 tópicos na ordem e as regras do livro. Não usa banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SECTORS } = require('../../../src/features/core-governance/bcp/bcp.constants');
const { FORMS } = require('../../../src/features/core-governance/bcp/bcp.forms.constants');

const DIR = path.join(__dirname, '..', '..', '..', 'docs', 'runbooks', 'bcp');
const TOPICS = [
  'Quando acionar', 'Quem aciona e quem é o responsável', 'O que continua funcionando sem o sistema', 'Passo a passo manual',
  'O que é proibido fazer manualmente', 'Como registrar para reconciliação', 'Como encerrar a contingência e importar',
];
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

test('m9d830 existem os seis runbooks com os 7 tópicos', () => {
  assert.deepEqual(fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort(), SECTORS.map((s) => s.runbook).sort(), 'exatamente os 6 arquivos do catálogo');
  for (const sector of SECTORS) {
    const headings = [...read(sector.runbook).matchAll(/^## (\d)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2].trim()]);
    assert.deepEqual(headings, TOPICS.map((title, i) => [i + 1, title]), `${sector.runbook}: os 7 tópicos, nesta ordem`);
    const text = read(sector.runbook);
    assert.ok(text.includes(`${sector.prefix}-AAAA-nnnnn`), `${sector.runbook} cita a numeração ${sector.prefix}-AAAA-nnnnn`);
    for (const form of FORMS.filter((f) => f.sector === sector.sector)) {
      assert.ok(text.includes(form.formType), `${sector.runbook} cita o formulário ${form.formType}`);
      assert.ok(text.includes(form.action), `${sector.runbook} cita a intenção ${form.action}`);
    }
  }
});

test('m9d830 runbook financeiro cita a proibição de pagamento sem dupla checagem', () => {
  const text = read('financeiro.md');
  assert.match(text, /PAGAMENTO manual sem dupla checagem[^\n]*proibido/);
  assert.match(text, /dupla checagem/);
  assert.match(text, /concili/i);
});

test('m9d830 regras de numeração e formulário do livro (K7): OBR sem prefixo próprio de requisição e vistoria no campo estado do imóvel', () => {
  const obras = read('obras.md');
  assert.match(obras, /REQUISICAO_MATERIAL/);
  assert.match(obras, /não existe `OBR-REQ`/);
  assert.match(read('locacao.md'), /estado do imóvel/);
  for (const sector of SECTORS) assert.doesNotMatch(read(sector.runbook), /\b(ATD|LOC)-\d{4}\b(?!-)/, 'nenhum formato antigo ATD-nnnn/LOC-nnnn');
});
