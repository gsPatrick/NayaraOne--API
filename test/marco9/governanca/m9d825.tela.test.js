'use strict';

// M9-D825 — comportamento do componente ProtectedValue do Front (NayaraOne--FRONT/lib/dlp/protectedValue.logic.js), provado sobre a lógica pura que o componente
// usa, com área de transferência e rede simuladas. Sem Playwright (regra do projeto neste ciclo): o roteiro de tela está na seção 9 da demanda.
const { testeComIrmaos } = require('../../helpers/repoIrmao');

// A lógica pura do componente mora no Front: ausente, os testes falham; no CI sem o Front (CI_SEM_REPOS_IRMAOS=1) viram NAO_APLICAVEL_NO_CI.
const test = testeComIrmaos(['NayaraOne--FRONT/lib/dlp/protectedValue.logic.js']);
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FILE = path.join(__dirname, '..', '..', '..', '..', 'NayaraOne--FRONT', 'lib', 'dlp', 'protectedValue.logic.js');
const logic = () => import(pathToFileURL(FILE).href);
const TARGET = { resourceType: 'finance.bank_account', resourceId: 'acc-1', field: 'accountNumber' };

function bench() {
  const clipboard = { value: 'ANTERIOR', writes: 0 };
  const calls = [];
  return {
    clipboard, calls,
    writeClipboard: async (text) => { clipboard.value = text; clipboard.writes += 1; },
    postOk: async (event) => { calls.push(event); return { id: 'x' }; },
    postFail: async (event) => { calls.push(event); throw Object.assign(new Error('rede'), { code: 'NETWORK_ERROR' }); },
  };
}

test('m9d825 COPY de RESTRICTED é negado e a área de transferência fica inalterada', async () => {
  const { copyProtected, COPY_DENIED_MESSAGE } = await logic();
  const b = bench();
  const out = await copyProtected({ classification: 'RESTRICTED', text: '12345678-9', target: TARGET, postCopyEvent: b.postOk, writeClipboard: b.writeClipboard });
  assert.deepEqual([out.copied, out.reason, out.message], [false, 'DENIED', COPY_DENIED_MESSAGE]);
  assert.equal(COPY_DENIED_MESSAGE, 'Este dado não pode ser copiado');
  assert.equal(b.clipboard.value, 'ANTERIOR');
  assert.equal(b.clipboard.writes, 0);
  assert.deepEqual(b.calls, [{ ...TARGET, outcome: 'DENIED' }], 'a negação é registrada');
  const offline = bench();
  const again = await copyProtected({ classification: 'RESTRICTED', text: 'x', target: TARGET, postCopyEvent: offline.postFail, writeClipboard: offline.writeClipboard });
  assert.equal(again.copied, false, 'sem rede a negação continua negando');
  assert.equal(offline.clipboard.writes, 0);
});

test('m9d825 Ctrl+C, recortar, arrastar e menu de contexto em RESTRICTED são cancelados e registrados', async () => {
  const { handleClipboardEvent } = await logic();
  const seen = [];
  for (const type of ['copy', 'cut', 'dragstart', 'contextmenu']) {
    let prevented = false;
    const cancelled = handleClipboardEvent({ type, preventDefault: () => { prevented = true; } }, 'RESTRICTED', { onDenied: (t) => seen.push(t), onRecordedCopy: () => assert.fail('RESTRICTED nunca copia') });
    assert.deepEqual([cancelled, prevented], [true, true], type);
  }
  assert.deepEqual(seen, ['copy', 'cut', 'dragstart', 'contextmenu']);
  let prevented = false;
  assert.equal(handleClipboardEvent({ type: 'copy', preventDefault: () => { prevented = true; } }, 'LOW', { onDenied: () => assert.fail('x'), onRecordedCopy: () => assert.fail('x') }), false);
  assert.equal(prevented, false, 'LOW e MEDIUM seguem livres');
});

test('m9d825 COPY de HIGH copia e audita', async () => {
  const { copyProtected, handleClipboardEvent } = await logic();
  const b = bench();
  const out = await copyProtected({ classification: 'HIGH', text: 'ana@exemplo.com', target: { ...TARGET, field: 'email' }, postCopyEvent: b.postOk, writeClipboard: b.writeClipboard });
  assert.deepEqual([out.copied, out.recorded], [true, true]);
  assert.equal(b.clipboard.value, 'ana@exemplo.com');
  assert.deepEqual(b.calls.map((c) => c.outcome), ['ALLOWED'], 'registrado antes de copiar');
  const order = [];
  await copyProtected({ classification: 'HIGH', text: 'x', target: TARGET, postCopyEvent: async () => { order.push('registro'); return { id: 1 }; }, writeClipboard: async () => { order.push('copia'); } });
  assert.deepEqual(order, ['registro', 'copia']);
  const ran = [];
  let prevented = false;
  handleClipboardEvent({ type: 'copy', preventDefault: () => { prevented = true; } }, 'HIGH', { onDenied: () => assert.fail('HIGH não nega'), onRecordedCopy: (t) => ran.push(t) });
  assert.deepEqual([prevented, ran], [true, ['copy']], 'o copy nativo é cancelado e refeito com registro');
});

test('m9d825 falha no registro da cópia cancela a cópia', async () => {
  const { copyProtected, COPY_NOT_RECORDED_MESSAGE } = await logic();
  const b = bench();
  const out = await copyProtected({ classification: 'HIGH', text: 'ana@exemplo.com', target: TARGET, postCopyEvent: b.postFail, writeClipboard: b.writeClipboard });
  assert.deepEqual([out.copied, out.reason, out.message], [false, 'NOT_RECORDED', COPY_NOT_RECORDED_MESSAGE]);
  assert.equal(b.clipboard.writes, 0, 'não copia sem registrar');
  const empty = await copyProtected({ classification: 'HIGH', text: 'x', target: TARGET, postCopyEvent: async () => null, writeClipboard: b.writeClipboard });
  assert.equal(empty.copied, false);
  const denied = await copyProtected({ classification: 'HIGH', text: 'x', target: TARGET, postCopyEvent: async () => { throw Object.assign(new Error('n'), { code: 'GOV_DLP_DENIED' }); }, writeClipboard: b.writeClipboard });
  assert.deepEqual([denied.copied, denied.reason], [false, 'DENIED'], 'o servidor reavaliou e negou');
  const off = await copyProtected({ classification: 'HIGH', text: 'x', target: TARGET, postCopyEvent: async () => { throw Object.assign(new Error('d'), { code: 'GOV_MODULE_DISABLED' }); }, writeClipboard: b.writeClipboard });
  assert.deepEqual([off.copied, off.recorded], [true, false], 'DLP desligado pelo administrador: não bloqueia');
});

test('m9d825 cópia em massa de coluna RESTRICTED sai mascarada ou omitida', async () => {
  const { renderModel, isServerMasked } = await logic();
  const restricted = renderModel({ classification: 'RESTRICTED', value: '12345678-9' });
  assert.equal(restricted.domText, '', 'o valor não existe como texto no DOM: selecionar tudo e copiar a tabela omite a coluna');
  assert.deepEqual([restricted.selectable, restricted.showCopyButton, restricted.dlpClass], [false, false, 'RESTRICTED']);
  const masked = renderModel({ classification: 'RESTRICTED', value: '****78-9' });
  assert.equal(masked.domText, '', 'mascarado pelo servidor também não vira texto copiável');
  assert.equal(isServerMasked('****78-9'), true);
  const high = renderModel({ classification: 'HIGH', value: 'ana@exemplo.com' });
  assert.deepEqual([high.domText, high.showCopyButton, high.selectable], ['ana@exemplo.com', true, true]);
  assert.equal(renderModel({ classification: 'HIGH', value: '********' }).showCopyButton, false, 'não oferece copiar valor mascarado');
  assert.deepEqual(renderModel({ classification: 'LOW', value: 'x' }), { mode: 'FREE', visualText: 'x', domText: 'x', selectable: true, showCopyButton: false, dlpClass: null });
});

test('m9d825 o valor mascarado pelo servidor nunca volta na edição', async () => {
  const { dropMaskedFields } = await logic();
  const original = { agency: '0001', accountNumber: '****78-9', pixKey: '********' };
  assert.deepEqual(dropMaskedFields({ agency: '0002', accountNumber: '****78-9', pixKey: '' }, original, ['accountNumber', 'pixKey']), { agency: '0002' });
  assert.deepEqual(dropMaskedFields({ agency: '0002', accountNumber: '99999-0', pixKey: '' }, original, ['accountNumber', 'pixKey']), { agency: '0002', accountNumber: '99999-0' }, 'o que o usuário digitou segue');
  assert.deepEqual(dropMaskedFields({ accountNumber: '12345678-9' }, { accountNumber: '12345678-9' }, ['accountNumber']), { accountNumber: '12345678-9' }, 'valor em claro não é mexido');
});
