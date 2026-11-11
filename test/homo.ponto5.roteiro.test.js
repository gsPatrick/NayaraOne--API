'use strict';

// Peças puras do reteste do ponto 5 do Marco 9 (scripts/homo/retestePonto5Marco9.js): regra da etiqueta da ficha, horário de
// silêncio e o arquivo de segredos fora do repositório (nunca senha/segredo na linha de comando). Não fala com API nem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { estadoDoCanal } = require('../scripts/homo/ponto5/contatos');
const { noSilencio } = require('../scripts/homo/ponto5/bloqueio');
const { carregarSegredos, recusarSegredoNaLinhaDeComando, interpretar } = require('../scripts/homo/lib/segredosArquivo');
const { INCOMPLETAS } = require('../scripts/homo/ponto5/automacoes');
const { collectProblems } = require('../src/features/marketing/automations/definition.validation');

test('a etiqueta da ficha segue a regra do Front: o último registro de cada finalidade vale e qualquer OPT_OUT vence', () => {
  const c = (purpose, status) => ({ channel: 'EMAIL', purpose, status });
  assert.equal(estadoDoCanal([c('MARKETING', 'OPT_OUT'), c('MARKETING', 'OPT_IN')], 'EMAIL'), 'OPT_OUT');
  assert.equal(estadoDoCanal([c('MARKETING', 'OPT_IN'), c('MARKETING', 'OPT_OUT')], 'EMAIL'), 'OPT_IN');
  assert.equal(estadoDoCanal([c('NUTRICAO', 'OPT_OUT'), c('MARKETING', 'OPT_IN')], 'EMAIL'), 'OPT_OUT');
  assert.equal(estadoDoCanal([], 'EMAIL'), null);
  assert.equal(estadoDoCanal([{ channel: 'WHATSAPP', purpose: 'MARKETING', status: 'OPT_OUT' }], 'EMAIL'), null);
});

test('horário de silêncio: janela que cruza a meia-noite e a folga antes do início', () => {
  const sp = (hhmm) => new Date(`2026-11-11T${hhmm}:00-03:00`);
  const v = '21:00 a 08:00 America/Sao_Paulo';
  assert.equal(noSilencio(v, sp('22:30')).silencio, true);
  assert.equal(noSilencio(v, sp('07:59')).silencio, true);
  assert.equal(noSilencio(v, sp('10:00')).silencio, false);
  assert.equal(noSilencio(v, sp('20:57')).silencio, true, 'começa dentro da folga de 6 minutos');
  assert.equal(noSilencio('valor fora do formato', sp('22:30')).silencio, false);
});

test('os cinco tipos de ação do roteiro são exatamente os que a validação da automação recusa sem o campo', () => {
  assert.equal(INCOMPLETAS.length, 5);
  for (const { tipo, campo, acao } of INCOMPLETAS) {
    const campos = collectProblems({ triggerType: 'EVENT', actions: [acao] }).map((p) => p.field);
    assert.ok(campos.includes(`actions[0].${campo}`), `${tipo}: ${campos.join(', ')}`);
  }
});

test('segredos: argumento com cara de segredo para o script; arquivo dentro de repositório ou aberto a outros é recusado', () => {
  assert.throws(() => recusarSegredoNaLinhaDeComando(['--senha=x']), /não recebe senha/);
  assert.throws(() => recusarSegredoNaLinhaDeComando(['HOMO_X_MFA_SECRET=abc']), /não recebe senha/);
  assert.doesNotThrow(() => recusarSegredoNaLinhaDeComando([]));

  const dentro = path.join(__dirname, `segredos-teste-${process.pid}.env`);
  fs.writeFileSync(dentro, 'HOMO_ADMIN_PASSWORD=x\n', { mode: 0o600 });
  try { assert.throws(() => carregarSegredos({ HOMO_SEGREDOS_ARQUIVO: dentro }), /dentro do repositório/); } finally { fs.rmSync(dentro); }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-segredos-'));
  const fora = path.join(dir, 'segredos.env');
  try {
    fs.writeFileSync(fora, '# comentário\nHOMO_ADMIN_PASSWORD="senha do arquivo"\nexport HOMO_OUTRA_EMPRESA_MFA_SECRET=ABC\n', { mode: 0o644 });
    fs.chmodSync(fora, 0o644);
    assert.throws(() => carregarSegredos({ HOMO_SEGREDOS_ARQUIVO: fora }), /chmod 600/);
    fs.chmodSync(fora, 0o600);
    const env = carregarSegredos({ HOMO_SEGREDOS_ARQUIVO: fora, HOMO_ADMIN_PASSWORD: 'do ambiente' });
    assert.equal(env.HOMO_ADMIN_PASSWORD, 'do ambiente', 'o ambiente tem prioridade');
    assert.equal(env.HOMO_OUTRA_EMPRESA_MFA_SECRET, 'ABC');
    assert.throws(() => interpretar('SENHA=1'), /fora do formato/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
