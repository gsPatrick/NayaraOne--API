'use strict';

// Trava do horário de silêncio do reteste do ponto 5 (achado ISO-R9 da verificação de 12/11/2026, DI-M9R-5). Antes: o roteiro
// lia GET /settings/marketing.quiet_hours, que responde 404 SETTING_NOT_FOUND com o parâmetro no PADRÃO, entendia "sem
// silêncio" e criava e agendava a campanha às 07:20 (dentro do padrão 21:00 a 08:00). Agora vale o valor EFETIVO (gravado ou,
// sem linha, o padrão do catálogo) e, no silêncio, o roteiro recusa rodar com código 2 antes de gravar qualquer coisa.
// Não fala com a API real nem com banco: sessão falsa e um servidor HTTP falso local que só registra as chamadas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const silencio = require('../scripts/homo/ponto5/silencio');
const bloqueio = require('../scripts/homo/ponto5/bloqueio');
const { PararScript } = require('../scripts/homo/lib/cliente');

const PADRAO = '21:00 a 08:00 America/Sao_Paulo';
const sp = (hhmm) => new Date(`2026-11-12T${hhmm}:00-03:00`);
const NAO_GRAVADO = { status: 404, dados: null, erro: { code: 'SETTING_NOT_FOUND', message: 'Configuração "marketing.quiet_hours" não encontrada para este tenant.' } };
const gravado = (value) => ({ status: 200, dados: { key: 'marketing.quiet_hours', value }, erro: null });

/** Sessão falsa: responde a configuração pedida, lista de auditoria vazia e 201 na criação da campanha; registra cada chamada. */
function sessaoFalsa(respostaSilencio) {
  const chamadas = [];
  return {
    chamadas,
    async chamar(metodo, rota, corpo) {
      chamadas.push(`${metodo} ${rota}`);
      if (rota === '/settings/marketing.quiet_hours') return respostaSilencio;
      if (metodo === 'GET' && rota.startsWith('/audit-log')) return { status: 200, dados: [], erro: null };
      if (metodo === 'POST' && rota === '/marketing/campaigns') return { status: 201, dados: { id: 'campanha-criada', ...corpo }, erro: null };
      return { status: 500, dados: null, erro: { code: 'NAO_ESPERADO' } };
    },
  };
}
const parada = (padrao) => (e) => e instanceof PararScript && e.codigoSaida === 2 && padrao.test(e.message);

test('o padrão usado quando não há valor gravado é o do catálogo de parâmetros (parametros.csv)', (t) => {
  assert.equal(silencio.PADRAO, PADRAO);
  // Layout de irmãos (<pasta>/API ao lado de <pasta>/Maturacao) ou worktree em NayaraOne/wt/<nome>.
  const candidatos = [path.join(__dirname, '..', '..', 'Maturacao'), path.join(__dirname, '..', '..', '..', 'Maturacao')].map((m) => path.join(m, 'demandas', 'parametros.csv'));
  const csv = candidatos.find((c) => fs.existsSync(c));
  if (!csv) return t.skip(`catálogo ausente neste layout: ${candidatos.join(' ou ')}`);
  const linha = fs.readFileSync(csv, 'utf8').split('\n').find((l) => l.startsWith('"marketing.quiet_hours",'));
  assert.ok(linha, 'marketing.quiet_hours no catálogo');
  assert.equal(linha.split('","')[4], PADRAO);
});

test('parâmetro no PADRÃO (GET 404 SETTING_NOT_FOUND): às 07:20 de São Paulo o roteiro para, às 10:00 segue', async () => {
  const ctx = { admin: sessaoFalsa(NAO_GRAVADO), agora: () => sp('07:20') };
  await assert.rejects(silencio.exigirForaDoSilencio(ctx), parada(/RECUSADO: agora é horário de silêncio do Marketing \(21:00 a 08:00 America\/Sao_Paulo, padrão do catálogo \(sem valor gravado na empresa\)\).*Nada foi criado/));
  for (const hora of ['21:00', '23:59', '00:00', '07:59', '20:55']) {
    await assert.rejects(silencio.exigirForaDoSilencio({ ...ctx, agora: () => sp(hora) }), parada(/horário de silêncio/), `às ${hora} é silêncio (ou começa em menos de 6 minutos)`);
  }
  for (const hora of ['08:00', '10:00', '20:53']) {
    const ok = await silencio.exigirForaDoSilencio({ ...ctx, agora: () => sp(hora) });
    assert.deepEqual(ok, { valor: PADRAO, origem: 'padrão do catálogo (sem valor gravado na empresa)' }, `às ${hora} está fora do silêncio`);
  }
});

test('parâmetro GRAVADO: vale o valor da empresa, não o padrão', async () => {
  const ctx = { admin: sessaoFalsa(gravado('13:00 a 14:00 America/Sao_Paulo')), agora: () => sp('13:30') };
  await assert.rejects(silencio.exigirForaDoSilencio(ctx), parada(/13:00 a 14:00 America\/Sao_Paulo, valor gravado na empresa/));
  // 07:20 está no padrão, mas a empresa gravou outro horário: segue.
  assert.equal((await silencio.exigirForaDoSilencio({ ...ctx, agora: () => sp('07:20') })).origem, 'valor gravado na empresa');
  // Valor gravado que a API não aceita: a rotina usa o padrão, e o roteiro também.
  const invalido = { admin: sessaoFalsa(gravado('das nove às oito')), agora: () => sp('07:20') };
  await assert.rejects(silencio.exigirForaDoSilencio(invalido), parada(/21:00 a 08:00 America\/Sao_Paulo, padrão do catálogo \(o valor gravado "das nove às oito" não é aceito/));
});

test('sem conseguir ler o parâmetro (403, 500), o roteiro para: a trava falha fechada', async () => {
  for (const r of [{ status: 403, dados: null, erro: { code: 'FORBIDDEN' } }, { status: 500, dados: null, erro: { code: 'INTERNAL_ERROR' } }, { status: 404, dados: null, erro: { code: 'NOT_FOUND' } }]) {
    await assert.rejects(silencio.exigirForaDoSilencio({ admin: sessaoFalsa(r), agora: () => sp('10:00') }), parada(new RegExp(`Não consegui ler o horário de silêncio do Marketing \\(GET /settings/marketing.quiet_hours: HTTP ${r.status} ${r.erro.code}\\)`)));
  }
});

test('bloqueio: no silêncio a campanha NÃO é criada (padrão e gravado); fora dele é criada', async () => {
  for (const resposta of [NAO_GRAVADO, gravado('07:00 a 08:00 America/Sao_Paulo')]) {
    const admin = sessaoFalsa(resposta);
    await assert.rejects(bloqueio.garantirCampanha({ admin, agora: () => sp('07:20') }, 'modelo', ['a', 'b', 'c']), parada(/horário de silêncio/));
    assert.ok(!admin.chamadas.some((c) => c.startsWith('POST ')), `nenhuma gravação no silêncio: ${admin.chamadas.join(', ')}`);
  }
  const admin = sessaoFalsa(NAO_GRAVADO);
  const r = await bloqueio.garantirCampanha({ admin, agora: () => sp('10:00') }, 'modelo', ['a', 'b', 'c']);
  assert.equal(r.id, 'campanha-criada');
  assert.ok(admin.chamadas.includes('POST /marketing/campaigns'));
});

// ---- O roteiro inteiro, contra uma API falsa local: no silêncio sai com código 2 sem gravar nada. ----

const hhmmUtc = (d) => d.toISOString().slice(11, 16);

/** API falsa: login dos três perfis, a configuração pedida e 500 para todo o resto (registra cada chamada). */
async function apiFalsa(respostaSilencio) {
  const chamadas = [];
  const claims = (c) => Buffer.from(JSON.stringify(c)).toString('base64url');
  const server = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const rota = req.url.replace(/^\/api\/v1/, '');
      chamadas.push(`${req.method} ${rota}`);
      const responder = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.method === 'POST' && rota === '/auth/login') {
        const b = JSON.parse(corpo || '{}');
        const companyId = b.companyId || 'empresa-a';
        return responder(200, { data: { accessToken: `x.${claims({ company_id: companyId, group_id: 'grupo-1', user_id: b.email })}.y`, user: { id: `u-${b.email}` } } });
      }
      if (req.method === 'GET' && rota === '/settings/marketing.quiet_hours') {
        return responder(respostaSilencio.status, respostaSilencio.status === 200 ? { data: respostaSilencio.dados } : { error: respostaSilencio.erro });
      }
      return responder(500, { error: { code: 'API_FALSA', message: 'fora do escopo do teste' } });
    });
  });
  await new Promise((resolve) => { server.listen(Number(process.env.HOMO_ROTEIRO_FALSO_PORT) || 0, '127.0.0.1', resolve); });
  return { chamadas, base: `http://127.0.0.1:${server.address().port}/api/v1`, fechar: () => new Promise((resolve) => { server.close(resolve); }) };
}

function rodarRoteiro(base) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, HOMO_API_BASE: base, HOMO_OUTRA_EMPRESA_COMPANY_ID: 'empresa-b' };
  for (const p of ['ADMIN', 'LEITURA', 'OUTRA_EMPRESA']) { env[`HOMO_${p}_EMAIL`] = `${p.toLowerCase()}@exemplo.invalid`; env[`HOMO_${p}_PASSWORD`] = 'senha-ficticia-do-teste'; }
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'homo', 'retestePonto5Marco9.js')], { env });
    let saida = ''; let erro = '';
    filho.stdout.on('data', (c) => { saida += c; });
    filho.stderr.on('data', (c) => { erro += c; });
    filho.on('close', (codigo) => resolve({ codigo, saida, erro }));
  });
}

const SO_LEITURA_DA_TRAVA = ['POST /auth/login', 'POST /auth/login', 'POST /auth/login', 'GET /settings/marketing.quiet_hours'];

test('roteiro inteiro, parâmetro GRAVADO com a janela de agora: sai com código 2, mensagem clara e nenhuma chamada além dos logins e da leitura', async () => {
  const agora = new Date();
  const api = await apiFalsa(gravado(`${hhmmUtc(new Date(agora.getTime() - 3600000))} a ${hhmmUtc(new Date(agora.getTime() + 3600000))} UTC`));
  try {
    const r = await rodarRoteiro(api.base);
    assert.equal(r.codigo, 2, `${r.saida}\n${r.erro}`);
    assert.match(r.erro, /PARADO: RECUSADO: agora é horário de silêncio do Marketing \(.* UTC, valor gravado na empresa\)\..*Nada foi criado/);
    assert.deepEqual(api.chamadas, SO_LEITURA_DA_TRAVA);
  } finally { await api.fechar(); }
});

test('roteiro inteiro, parâmetro GRAVADO longe de agora: passa da trava e segue para os cenários', async () => {
  const agora = new Date();
  const api = await apiFalsa(gravado(`${hhmmUtc(new Date(agora.getTime() + 3 * 3600000))} a ${hhmmUtc(new Date(agora.getTime() + 4 * 3600000))} UTC`));
  try {
    const r = await rodarRoteiro(api.base);
    assert.match(r.saida, /Horário de silêncio do Marketing: .* UTC \(valor gravado na empresa\); agora está fora dele\./);
    assert.ok(api.chamadas.length > SO_LEITURA_DA_TRAVA.length, 'depois da trava o roteiro seguiu para os cenários');
    assert.notEqual(r.codigo, 0, 'a API falsa não atende os cenários: o roteiro não pode terminar como "tudo conferido"');
  } finally { await api.fechar(); }
});

test('roteiro inteiro, parâmetro no PADRÃO (404): a decisão segue o padrão 21:00 a 08:00 de São Paulo na hora da execução', async () => {
  const api = await apiFalsa(NAO_GRAVADO);
  try {
    const antes = silencio.noSilencio(PADRAO, new Date()).silencio;
    const r = await rodarRoteiro(api.base);
    const depois = silencio.noSilencio(PADRAO, new Date()).silencio;
    if (antes !== depois) return; // virou o horário durante a execução: as duas respostas seriam corretas
    if (antes) {
      assert.equal(r.codigo, 2, `${r.saida}\n${r.erro}`);
      assert.match(r.erro, /PARADO: RECUSADO: agora é horário de silêncio do Marketing \(21:00 a 08:00 America\/Sao_Paulo, padrão do catálogo \(sem valor gravado na empresa\)\)/);
      assert.deepEqual(api.chamadas, SO_LEITURA_DA_TRAVA);
    } else {
      assert.match(r.saida, /Horário de silêncio do Marketing: 21:00 a 08:00 America\/Sao_Paulo \(padrão do catálogo \(sem valor gravado na empresa\)\); agora está fora dele\./);
      assert.ok(api.chamadas.length > SO_LEITURA_DA_TRAVA.length);
    }
  } finally { await api.fechar(); }
});
