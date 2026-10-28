'use strict';

// Marco 9, M9-D246 — varredura estática de segredo (scripts/secretScan.js) e teste de arquitetura da biblioteca única. Sem banco.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..', '..');
const SCAN = path.join(RAIZ, 'scripts', 'secretScan.js');

const rodar = (args) => spawnSync(process.execPath, [SCAN, ...args], { cwd: RAIZ, encoding: 'utf8' });

test('secret_scan_repositorio_sem_padroes', () => {
  const r = rodar([]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /secretScan: 0 achados em \d+ arquivos/);
  assert.equal(r.stderr, '');
});

test('secret_scan_acha_cada_padrao_bloqueia_com_codigo_e_nao_repete_o_segredo', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-m9-'));
  const plantados = {
    aws_access_key: 'AKIAABCDEFGHIJKLMNOP',
    private_key_pem: '-----BEGIN RSA PRIVATE KEY-----',
    stripe_live_key: 'sk_live_abcdefghijkl',
    slack_token: 'xoxb-1234567890-abcdef',
    github_token: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJh',
    bearer_token: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
    connection_string_with_password: 'postgres://dono:SENHA-REAL-123@db.interno:5432/app',
  };
  try {
    Object.values(plantados).forEach((texto, i) => fs.writeFileSync(path.join(pasta, `arquivo${i}.txt`), `linha\n${texto}\n`));
    fs.writeFileSync(path.join(pasta, 'limpo.txt'), 'nada aqui\n');
    const vazia = path.join(pasta, 'allow.json');
    fs.writeFileSync(vazia, '{"entries":[]}');
    const r = rodar(['--root', pasta, '--allowlist', vazia]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /INTEGRATION_SECRET_SCAN_FAILED: Segredo encontrado no código ou em logs: remova e rotacione\./);
    for (const nome of Object.keys(plantados)) assert.ok(r.stderr.includes(`[${nome}]`), `padrão ${nome} não apareceu:\n${r.stderr}`);
    assert.ok(!r.stderr.includes('SENHA-REAL-123') && !r.stderr.includes('abcdefghijklmnopqrstuvwxyz0123'), 'o relatório não repete o segredo inteiro');
    assert.ok(!r.stderr.includes('limpo.txt'));
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('secret_scan_allowlist_so_vale_revisada_e_log_de_ci_tambem_e_varrido', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-m9-'));
  try {
    fs.writeFileSync(path.join(pasta, 'exemplo.md'), 'use postgres://usuario:senha-exemplo@host/db\n');
    fs.writeFileSync(path.join(pasta, 'ci.log'), 'AKIAABCDEFGHIJKLMNOP\n');
    const entrada = { file: '^exemplo\\.md$', pattern: 'connection_string_with_password', reason: 'modelo de formato' };
    const allow = path.join(pasta, 'allow.json');
    fs.writeFileSync(allow, JSON.stringify({ entries: [entrada] }));
    assert.equal(rodar(['--root', pasta, '--allowlist', allow]).status, 1, 'sem reviewedBy a entrada não vale');
    fs.writeFileSync(allow, JSON.stringify({ entries: [{ ...entrada, reviewedBy: 'revisor' }] }));
    const comLog = rodar(['--root', pasta, '--allowlist', allow, '--extra', 'ci.log']);
    assert.equal(comLog.status, 1);
    assert.match(comLog.stderr, /ci\.log:1 \[aws_access_key\]/);
    assert.ok(!comLog.stderr.includes('exemplo.md'), 'entrada revisada vale');
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('secret_scan_esta_no_ci_antes_dos_testes_e_no_package_json', () => {
  const fluxo = fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'test.yml'), 'utf8');
  const posScan = fluxo.indexOf('node scripts/secretScan.js');
  assert.ok(posScan > 0, 'passo da varredura presente no workflow');
  assert.ok(posScan < fluxo.indexOf('Run test suite'), 'a varredura roda antes da suíte');
  assert.ok(fluxo.includes('secretScan.js --extra test-results.log'), 'o log desta execução também é varrido');
  assert.equal(JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).scripts['scan:secrets'], 'node scripts/secretScan.js');
});

function arquivosJs(dir, saida = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const cheio = path.join(dir, e.name);
    if (e.isDirectory()) arquivosJs(cheio, saida);
    else if (e.name.endsWith('.js')) saida.push(cheio);
  }
  return saida;
}

test('redaction_biblioteca_unica_sem_regex_de_deteccao_duplicada', () => {
  const proibidos = [
    ['JWT', /eyJ/], ['chave privada PEM', /PRIVATE KEY|-----BEGIN/], ['chave AWS', /AKIA/], ['chave de API conhecida', /sk_live|xox\[|ghp_/],
    ['CPF', /\\d\{3\}\\\.\??\\d\{3\}/], ['CNPJ', /\\d\{2\}\\\.\??\\d\{3\}/], ['e-mail', /\[A-Za-z0-9\._%\+-\]\+@|\[\^\\s@\]/],
    ['Luhn', /luhn/i], ['Bearer', /bearer\\s/i],
  ];
  const base = path.join(RAIZ, 'src');
  const biblioteca = path.join(base, 'shared', 'redaction') + path.sep;
  const achados = [];
  for (const arquivo of arquivosJs(base)) {
    if (arquivo.startsWith(biblioteca)) continue;
    fs.readFileSync(arquivo, 'utf8').split('\n').forEach((linha, i) => {
      for (const [nome, re] of proibidos) if (re.test(linha)) achados.push(`${path.relative(RAIZ, arquivo)}:${i + 1} (${nome})`);
    });
  }
  assert.deepEqual(achados, [], `detecção de PII/segredo fora de src/shared/redaction:\n${achados.join('\n')}`);
  // a biblioteca existe e é consumida pelos perfis citados no livro
  for (const consumidor of ['src/features/integrations/errors/sanitizeForError.js', 'src/features/marketing/content/sanitize.js', 'src/utils/logger.js']) {
    assert.match(fs.readFileSync(path.join(RAIZ, consumidor), 'utf8'), /shared\/redaction/, consumidor);
  }
});
