'use strict';

// Marco 9, M9-D242 — identidade atrás do port: algoritmo none recusado, iss/aud/exp/nbf obrigatórios com tolerância de 60 s, JWKS com cache e rotação, identity-local sobre o token do sistema.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const env = require('../_helpers/m9d242Env');
const { IdentitySandboxAdapter, resetIdentitySandbox } = require('../../../src/features/integrations/providers/identity/sandbox/identity-sandbox.adapter');
const { IdentityLocalAdapter } = require('../../../src/features/integrations/providers/identity/identity-local.adapter');
const keys = require('../../../src/features/integrations/providers/identity/sandbox/identity.sandbox.keys');
const { signAccessToken } = require('../../../src/utils/jwt');
const { verifyJwtStrict } = require('../../../src/shared/identity/jwtStrict');

const agora = () => Math.floor(Date.now() / 1000);
const META = { algorithms: ['RS256'], clockToleranceS: 60, jwksCacheTtlS: 300 };
const invalido = (motivo) => (e) => e.statusCode === 401 && e.code === 'INTEGRATION_IDENTITY_TOKEN_INVALID' && (!motivo || e.details.reason === motivo);

beforeEach(() => resetIdentitySandbox());

test('identity_jwt_algoritmo_none_recusado', async () => {
  const sbx = new IdentitySandboxAdapter(null);
  const ctx = env.ctxSandbox();
  const claims = { sub: 'u1', iss: 'identity-sandbox', aud: 'nayara-one', iat: agora(), nbf: agora(), exp: agora() + 600 };
  // Token sem assinatura, mesmo com todas as claims certas e mesmo se a configuração listar "none".
  await assert.rejects(sbx.verifyToken(ctx, { token: env.tokenSemAssinatura(claims) }, META), invalido('ALG_NOT_ALLOWED'));
  await assert.rejects(sbx.verifyToken(ctx, { token: env.tokenSemAssinatura(claims) }, { ...META, algorithms: ['none', 'RS256'] }), invalido());
  assert.throws(() => verifyJwtStrict(env.tokenSemAssinatura(claims), 'segredo', { algorithms: ['none'], issuer: 'identity-sandbox', audience: 'nayara-one' }), (e) => e.code === 'ALG_NOT_ALLOWED');
  // Confusão de algoritmo: HS256 assinado com a chave pública como segredo não passa numa lista só com RS256.
  const publica = JSON.stringify(keys.jwks().keys[0]);
  const hs = jwt.sign(claims, publica, { algorithm: 'HS256', keyid: keys.currentKid() });
  await assert.rejects(sbx.verifyToken(ctx, { token: hs }, META), invalido('ALG_NOT_ALLOWED'));
  // Token assinado por outra chave com o kid conhecido: assinatura inválida.
  const outra = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(sbx.verifyToken(ctx, { token: jwt.sign(claims, outra.privateKey, { algorithm: 'RS256', keyid: keys.currentKid() }) }, META), invalido('SIGNATURE_INVALID'));
  // O token certo passa.
  const ok = await sbx.verifyToken(ctx, { token: keys.issueToken({ sub: 'u1' }) }, META);
  assert.equal(ok.subject, 'u1');
  assert.equal(ok.status, 'VALID');
});

test('identity_iss_aud_exp_validados', async () => {
  const sbx = new IdentitySandboxAdapter(null);
  const ctx = env.ctxSandbox();
  const verificar = (claimsExtra, opts) => sbx.verifyToken(ctx, { token: keys.issueToken(claimsExtra, opts) }, META);
  await assert.rejects(verificar({}, { issuer: 'outro-emissor' }), invalido('CLAIM_MISMATCH:iss'));
  await assert.rejects(verificar({}, { audience: 'outro-publico' }), invalido('CLAIM_MISMATCH:aud'));
  await assert.rejects(verificar({}, { expiresInS: -120 }), invalido('TOKEN_EXPIRED'));
  await assert.rejects(verificar({}, { notBeforeOffsetS: 120 }), invalido('TOKEN_NOT_YET_VALID'));
  // Dentro da tolerância de relógio de 60 s: aceita.
  await verificar({}, { expiresInS: -30 });
  await verificar({}, { notBeforeOffsetS: 30 });
  // Claim obrigatória ausente.
  for (const c of ['exp', 'nbf', 'iss', 'aud', 'sub']) await assert.rejects(verificar({ [c]: undefined }), invalido(`CLAIM_MISSING:${c}`), c);
  // A tolerância vem da configuração: com 0 s, 30 s de atraso já vence.
  await assert.rejects(sbx.verifyToken(ctx, { token: keys.issueToken({}, { expiresInS: -30 }) }, { ...META, clockToleranceS: 0 }), invalido('TOKEN_EXPIRED'));
  // O emissor e o público esperados são da connection.
  const ctxCfg = env.ctxSandbox('cfg', { issuer: 'https://idp.exemplo.test', audience: 'api-nayara' });
  await sbx.verifyToken(ctxCfg, { token: keys.issueToken({}, { issuer: 'https://idp.exemplo.test', audience: 'api-nayara' }) }, META);
  await assert.rejects(sbx.verifyToken(ctxCfg, { token: keys.issueToken({}) }, META), invalido('CLAIM_MISMATCH:iss'));
});

test('identity_jwks_com_cache_e_rotacao', async () => {
  const sbx = new IdentitySandboxAdapter(null);
  const ctx = env.ctxSandbox('jwks-1');
  const doc = await sbx.listJwks(ctx, {});
  assert.equal(doc.keys.length, 1);
  assert.ok(!('d' in doc.keys[0]), 'o JWKS nunca leva a chave privada');
  await sbx.verifyToken(ctx, { token: keys.issueToken({}) }, META);
  await sbx.verifyToken(ctx, { token: keys.issueToken({}) }, META);
  assert.equal(sbx.cacheOf(ctx, 300).stats().loads, 1, 'duas validações, uma só leitura do JWKS (cache)');
  // Rotação: o token novo traz um kid desconhecido; o cache relê uma vez e passa. O token da chave antiga deixa de valer.
  const antigo = keys.issueToken({});
  keys.rotate();
  await sbx.verifyToken(ctx, { token: keys.issueToken({}) }, META);
  assert.equal(sbx.cacheOf(ctx, 300).stats().loads, 2);
  await assert.rejects(sbx.verifyToken(ctx, { token: antigo }, META), invalido('SIGNATURE_INVALID'));
});

test('identity_sandbox_revoga_sessao_e_falha_por_cabecalho', async () => {
  const sbx = new IdentitySandboxAdapter(null);
  const ctx = env.ctxSandbox('rev-1');
  await sbx.verifyToken(ctx, { token: keys.issueToken({ sid: 's-9' }) }, META);
  assert.equal((await sbx.revokeSession(ctx, { sessionId: 's-9' })).status, 'REVOKED');
  await assert.rejects(sbx.verifyToken(ctx, { token: keys.issueToken({ sid: 's-9' }) }, META), invalido('SESSION_REVOKED'));
  await assert.rejects(sbx.verifyToken(ctx, { token: keys.issueToken({}), headers: { 'x-sandbox-fail': '503' } }, META), (e) => e.status === 503 && sbx.classifyError(e).class === 'TRANSIENT');
  assert.equal((await sbx.healthCheck(ctx, { headers: { 'x-sandbox-fail': 'timeout' } })).ok, false);
  assert.equal(sbx.mapStatus('valid'), 'VALID');
  assert.equal(sbx.mapStatus('???'), null);
});

test('identity_local_valida_o_token_do_proprio_sistema', async () => {
  const local = new IdentityLocalAdapter(null);
  const ctx = env.ctxSandbox('local');
  const token = signAccessToken({ sub: 'user-1', group_id: 'g', company_id: 'c', roles: ['ADMIN'], permissions: [] });
  const r = await local.verifyToken(ctx, { token }, { clockToleranceS: 60 });
  assert.equal(r.subject, 'user-1');
  assert.deepEqual(r.claims.roles, ['ADMIN']);
  const decodificado = jwt.decode(token);
  assert.ok(decodificado.iss && decodificado.aud && decodificado.nbf && decodificado.exp, 'o token do sistema passa a levar iss, aud, nbf e exp');
  // Sem iss/aud/nbf (token de antes da D242 ou forjado com o mesmo segredo): recusado pelo adapter.
  const semClaims = jwt.sign({ sub: 'user-1' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
  await assert.rejects(local.verifyToken(ctx, { token: semClaims }, {}), invalido('CLAIM_MISSING:nbf'));
  await assert.rejects(local.verifyToken(ctx, { token: `${token}x` }, {}), invalido('SIGNATURE_INVALID'));
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'u', iss: decodificado.iss, aud: decodificado.aud })).toString('base64url')}.`;
  await assert.rejects(local.verifyToken(ctx, { token: none }, {}), invalido());
  const outroSegredo = jwt.sign({ sub: 'u', iss: decodificado.iss, aud: decodificado.aud }, 'segredo-de-outro-sistema-123456789', { expiresIn: '15m', notBefore: 0 });
  await assert.rejects(local.verifyToken(ctx, { token: outroSegredo }, {}), invalido('SIGNATURE_INVALID'));
  assert.deepEqual((await local.listJwks(ctx, {})).keys, []);
});
