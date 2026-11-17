'use strict';

// Infra de teste do Marco 5: os testes HTTP m5fech/m5ct sobem o app numa porta. Antes, 13 deles caíam na porta fixa 5534 (5536/5538 nos de locação,
// jurídico e no executor do pentest) e colidiam quando dois lotes rodavam em paralelo (verificação final de 17/11/2026: m5fech.contratos.adversariais e m5fech.juridico.rotas
// reprovaram sob carga e passaram sozinhos). Agora a porta vem da variável de sempre (M5FECH_CT_PORT, M5FECH_JURIDICO_HTTP_PORT, PORT) ou de uma
// porta livre escolhida pelo sistema (test/marco9/_helpers/portaLivre.js). Teste estático, sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const arquivos = fs.readdirSync(DIR).filter((f) => /^m5(fech|ct)\..+\.test\.js$/.test(f) && f !== path.basename(__filename));
// a linha que define a porta do app (process.env.PORT = ...) ou a do executor que o teste sobe (const port = ..., como o pentest)
const linhasDePorta = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter((l) => /process\.env\.PORT\s*=|\bconst port\s*=/.test(l));

test('nenhum teste m5fech/m5ct sobe o app numa porta fixa: variável ou porta livre', () => {
  const comPorta = arquivos.filter((f) => linhasDePorta(f).length > 0);
  assert.ok(comPorta.length >= 15, `esperava os testes HTTP do Marco 5, achei ${comPorta.length}`);
  const fixas = comPorta.flatMap((f) => linhasDePorta(f).filter((l) => /\|\|\s*'[1-9]\d*'\s*;/.test(l)).map((l) => `${f}: ${l.trim()}`));
  assert.deepEqual(fixas, [], 'porta fixa colide com outro lote rodando ao mesmo tempo');
  const semOrigem = comPorta.filter((f) => !linhasDePorta(f).every((l) => /portaLivre\(\)|\|\|\s*'0'\s*;/.test(l)));
  assert.deepEqual(semOrigem, [], 'cada porta vem de variável ou de porta livre (ou 0, escolhida pelo sistema)');
});

test('portaLivre devolve portas que dá para abrir e não repete a mesma em sequência', async () => {
  const net = require('node:net');
  const { portaLivre } = require('./marco9/_helpers/portaLivre');
  const portas = [portaLivre(), portaLivre(), portaLivre()];
  assert.ok(new Set(portas).size >= 2, `portas: ${portas}`);
  for (const p of portas) {
    await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(Number(p), '127.0.0.1', () => s.close(resolve)); });
  }
});
