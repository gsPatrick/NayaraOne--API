'use strict';

// M9-D871 — relatório de CI: syncFlagsRegistry exporta as flags dos seeds e check:flags lê o arquivo e reprova flag temporária vencida (sem banco).
//   NODE_ENV=test node --test test/marco9/governanca/m9d871.ci.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const node = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm9d871-'));

function seedsDir(flags) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'qa.seed.js'), `module.exports = ${JSON.stringify({ domain: 'qa', flags })};\n`);
  return dir;
}
const flag = (over) => ({ key: 'qa.m9d871.piloto', owner: 'Marketing', risk: 'LOW', temporary: true, validUntil: '2026-10-26T12:00:00Z', description: 'Piloto de teste.', ...over });

test('m9d871 syncFlagsRegistry exporta as flags dos seeds e check:flags lê o arquivo', () => {
  const seeds = seedsDir([flag(), flag({ key: 'qa.m9d871.permanente', temporary: false, validUntil: null })]);
  const out = path.join(tmp(), 'flags.json');
  const sync = node('syncFlagsRegistry.js', ['--seeds', seeds, '--out', out]);
  assert.equal(sync.status, 0, sync.stderr);
  const file = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(file.flags.map((f) => f.key), ['qa.m9d871.permanente', 'qa.m9d871.piloto'], 'ordenado por chave');
  assert.deepEqual(file.flags.find((f) => f.key === 'qa.m9d871.piloto'), { key: 'qa.m9d871.piloto', domain: 'qa', owner: 'Marketing', risk: 'LOW', temporary: true, validUntil: '2026-10-26T12:00:00.000Z', killSwitch: false, probe: null, description: 'Piloto de teste.', seed: 'qa.seed.js' });
  const again = path.join(tmp(), 'flags2.json');
  node('syncFlagsRegistry.js', ['--seeds', seeds, '--out', again]);
  assert.equal(fs.readFileSync(again, 'utf8'), fs.readFileSync(out, 'utf8'), 'o texto é determinístico');
  assert.equal(node('syncFlagsRegistry.js', ['--seeds', seeds, '--out', out, '--check']).status, 0, '--check confere o arquivo');
  fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace('Piloto', 'Mudou'));
  const stale = node('syncFlagsRegistry.js', ['--seeds', seeds, '--out', out, '--check']);
  assert.equal(stale.status, 1, 'arquivo desatualizado reprova');
});

test('m9d871 CI reprova flag vencida', () => {
  const seeds = seedsDir([flag()]);
  const file = path.join(tmp(), 'flags.json');
  assert.equal(node('syncFlagsRegistry.js', ['--seeds', seeds, '--out', file]).status, 0);
  const report = path.join(tmp(), 'relatorio.json');
  const bad = node('checkFeatureFlags.js', ['--file', file, '--now', '2026-10-27T10:00:00Z', '--out', report]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /GOV_FLAG_EXPIRED Flag vencida: qa\.m9d871\.piloto \(2026-10-26\)\./);
  const json = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepEqual([json.ok, json.checked, json.expired.length, json.expired[0].key, json.expired[0].validUntil, json.expired[0].code], [false, 1, 1, 'qa.m9d871.piloto', '2026-10-26', 'GOV_FLAG_EXPIRED']);
  assert.deepEqual(JSON.parse(bad.stdout).expired.map((e) => e.key), ['qa.m9d871.piloto'], 'a saída padrão também é JSON');
  const fine = node('checkFeatureFlags.js', ['--file', file, '--now', '2026-10-25T10:00:00Z']);
  assert.equal(fine.status, 0, 'antes do fim passa');
  assert.equal(JSON.parse(fine.stdout).ok, true);
});

test('m9d871 remoção da flag do seed limpa o relatório', () => {
  const file = path.join(tmp(), 'flags.json');
  node('syncFlagsRegistry.js', ['--seeds', seedsDir([flag()]), '--out', file]);
  assert.equal(node('checkFeatureFlags.js', ['--file', file, '--now', '2026-10-27T10:00:00Z']).status, 1);
  node('syncFlagsRegistry.js', ['--seeds', seedsDir([]), '--out', file]);
  const clean = node('checkFeatureFlags.js', ['--file', file, '--now', '2026-10-27T10:00:00Z']);
  assert.equal(clean.status, 0);
  assert.equal(JSON.parse(clean.stdout).checked, 0);
});

test('m9d871 seed com temporária sem validade, chave repetida ou chave inválida não gera o arquivo', () => {
  const out = path.join(tmp(), 'flags.json');
  const noExpiry = node('syncFlagsRegistry.js', ['--seeds', seedsDir([flag({ validUntil: null })]), '--out', out]);
  assert.equal(noExpiry.status, 1);
  assert.match(noExpiry.stderr, /GOV_FLAG_EXPIRY_REQUIRED Flag temporária precisa de data de expiração\./);
  assert.equal(node('syncFlagsRegistry.js', ['--seeds', seedsDir([flag(), flag()]), '--out', out]).status, 1, 'chave repetida');
  assert.equal(node('syncFlagsRegistry.js', ['--seeds', seedsDir([flag({ key: 'SemPonto' })]), '--out', out]).status, 1, 'chave fora do formato');
  assert.equal(fs.existsSync(out), false);
});

test('m9d871 check:flags reprova arquivo ilegível e temporária sem validade no arquivo', () => {
  const dir = tmp();
  assert.equal(node('checkFeatureFlags.js', ['--file', path.join(dir, 'nao-existe.json')]).status, 1);
  const file = path.join(dir, 'flags.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, flags: [{ key: 'qa.m9d871.x', temporary: true, validUntil: null }] }));
  const res = node('checkFeatureFlags.js', ['--file', file]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /GOV_FLAG_EXPIRY_REQUIRED/);
});

test('m9d871 o arquivo versionado docs/governance/flags.json existe, está em dia com os seeds e o package.json tem check:flags e sync:flags', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:flags'], 'node scripts/checkFeatureFlags.js');
  assert.equal(pkg.scripts['sync:flags'], 'node scripts/syncFlagsRegistry.js');
  assert.equal(node('syncFlagsRegistry.js', ['--check']).status, 0, 'rode npm run sync:flags para regenerar');
  assert.equal(node('checkFeatureFlags.js', []).status, 0, 'nenhuma flag declarada nos seeds está vencida');
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  assert.ok(workflow.indexOf('npm run sync:flags') > 0 && workflow.indexOf('npm run sync:flags') < workflow.indexOf('npm run check:flags'), 'a esteira gera o arquivo antes de conferir');
});
