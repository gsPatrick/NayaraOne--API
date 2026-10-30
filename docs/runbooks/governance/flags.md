# Runbook — Feature flags e kill switch (acionar, testar, flag vencida)

Módulo: `src/features/core-governance/feature-flags`. Rotas sob `$API/feature-flags` (`governance:flags:manage`). Kill switch é uma flag com `isKillSwitch = true`, risco CRITICAL e probe registrado; valor `true` significa acionado (função desligada).

Convenções: `$API` e `$TOKEN` como em `calendario.md`. Restaurar um kill switch pede MFA recente: quem opera digita o código na tela; nenhum comando abaixo contorna isso.

## Sintoma
- Incidente em que uma função precisa ser desligada agora.
- Aviso "CRÍTICO: flag vencida" para o responsável.
- O CI reprova com `GOV_FLAG_EXPIRED Flag vencida: <chave> (<data>).`
- Um kill switch aparece `UNVERIFIED` ou nunca testado.

## Causa provável
1. Flag temporária passou do `validUntil` (o job das 06:30 a marca `EXPIRED` e ela perde o efeito).
2. Seed versionado com flag temporária vencida.
3. O teste periódico do kill switch falhou (o probe não confirmou o efeito) ou ficou interrompido.

## Passo a passo
1. Acionar o kill switch (uma pessoa com a permissão, com motivo e confirmação de nível 2; sem MFA para desligar é a direção segura). Primeiro simular o impacto:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"key":"<chave do kill switch>","action":"activate"}' "$API/feature-flags/impact"
   curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"key":"<chave do kill switch>","value":true,"reason":"incidente <número>","confirmation":{"understood":true,"impactToken":"<token devolvido pela simulação>"}}' "$API/feature-flags"
   ```
   O corpo `confirmation` é `{understood?, typedCode?, justification?, impactToken}` (M9-D852). Restaurar (`value:false`) exige MFA recente, confirmação nível 3 (digitar a chave em `typedCode`, `justification` e o `impactToken`) e motivo.
2. Testar o kill switch fora do horário (somente HOMOLOG ou DEV; em PROD o job recusa com `GOV_KILL_DRILL_PROD_FORBIDDEN`):
   ```bash
   node -e "require('./src/engines/jobs/killSwitchDrillJob').runKillSwitchDrillJob(new Date(), { force: true }).then((r) => { console.log(JSON.stringify(r)); process.exit(0); })"
   ```
3. Flag vencida: prorrogar com motivo (o PATCH põe `validUntil` posterior a agora e a chave volta a `ACTIVE`) ou removê-la do seed se a flag deixou de existir:
   ```bash
   curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"id":"<uuid>","reason":"prorrogada até a entrega","validUntil":"2027-01-31T00:00:00-03:00"}' "$API/feature-flags"
   ```
4. Rodar o job de expiração e o relatório de CI:
   ```bash
   node -e "require('./src/engines/jobs/featureFlagExpiryJob').runFeatureFlagExpiryJob(new Date(), { force: true }).then(() => process.exit(0))"
   npm run sync:flags
   npm run check:flags
   ```

## Como confirmar
- `GET $API/feature-flags?id=<uuid>` mostra o novo valor e as `versoes` anteriores, com motivo e autor na auditoria.
- `npm run check:flags` termina com exit 0; o kill switch testado tem `verification_state = VERIFIED` e o registro `PASS` em `governance.kill_switch_drills`.
- O teste nomeado `m9d871 flag vencida alerta` segue verde (`node scripts/ci-governanca.sh flags`).

## Quem escalar
O responsável nomeado da flag; o segundo nome da escala de plantão para restaurar kill switch crítico; plataforma se o probe falhar.
