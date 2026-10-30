# Runbook — DLP (anomalia, revogar link, liberar suspensão)

Módulo: `src/features/core-governance/dlp`. Rotas: `$API/dlp/*` e `$API/exports/*`. Permissões: `governance:dlp:admin` (revisão e política), `governance:dlp:export` (pedir exportação e link).

Convenções: `$API` e `$TOKEN` como em `calendario.md`. Nenhum comando abaixo dispensa MFA: se a tela ou a API pedir `MFA_STEP_UP_REQUIRED`, quem opera digita o código na tela.

## Sintoma
- Alguém aparece "suspenso" para exportar, compartilhar ou imprimir (`GOV_DLP_USER_SUSPENDED`).
- Chegou o aviso de anomalia de acesso em massa (leituras HIGH/RESTRICTED, exportações, linhas em 24 h ou bloqueios repetidos).
- Um link externo precisa deixar de funcionar agora.
- Uma exportação ficou presa em `GENERATING` ou expirou antes do uso.

## Causa provável
1. O detector registrou sinais acima dos limiares de `governanca.dlp.anomalia.limiares` e abriu a anomalia (a suspensão dura `governanca.dlp.anomalia.suspensao_horas`).
2. Link criado com destinatário errado ou conteúdo que não devia sair.
3. O job de geração parou ou o arquivo passou do prazo da classe (`governanca.dlp.expiracao_horas_da_classe`).

## Passo a passo
1. Listar as anomalias abertas e ler o contexto (usuário, tipo de sinal, números):
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/dlp/anomalies?status=OPEN&pageSize=20"
   ```
2. Decidir com motivo escrito. `FALSE_POSITIVE` libera a suspensão; `CONFIRMED` mantém por `governanca.dlp.anomalia.confirmada_horas` e a suspensão cai sozinha depois:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"decision":"FALSE_POSITIVE","reason":"exportação mensal autorizada pelo financeiro"}' "$API/dlp/anomalies/<id>/review"
   ```
   Sem `reason` a API devolve 400 `GOV_ANOMALY_REASON_REQUIRED`; decidir de novo uma anomalia já revista devolve 409 `GOV_ANOMALY_INVALID_TRANSITION`.
3. Revogar um link externo (efeito imediato, o acesso público passa a devolver 404 `GOV_LINK_UNAVAILABLE`):
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/dlp/share-links"
   curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/dlp/share-links/<id>/revoke"
   ```
4. Exportação presa: rodar a geração e a expiração na hora (servidor do ambiente) e ver o estado:
   ```bash
   node -e "require('./src/engines/jobs/exportExpiryJob').runExportExpiryJob(new Date(), { force: true }).then(() => process.exit(0))"
   curl -s -H "Authorization: Bearer $TOKEN" "$API/exports/<exportJobId>"
   ```
5. Política de classe (por exemplo prazo ou teto de linhas): `GET $API/dlp/policies` e `PUT $API/dlp/policies/<CLASSE>/<AÇÃO>` com os campos que mudam. A API recusa enfraquecer o piso do livro (EXPORT de HIGH ou RESTRICTED sem justificativa, MFA, auditoria ou expiração): 422 `GOV_DLP_FLOOR_VIOLATION`.

## Como confirmar
- A anomalia sai da lista `status=OPEN`, a auditoria `governance.dlp.anomaly.reviewed` existe com o motivo e a pessoa volta a conseguir exportar.
- O link revogado devolve 404 em `GET /public/share/<token>` e a auditoria mostra quem revogou.
- O teste nomeado `m9d824 mass export dispara anomaly` e o `m9d822 export RESTRICTED sem MFA bloqueia` seguem verdes:
  ```bash
  bash scripts/ci-governanca.sh dlp
  ```

## Quem escalar
O encarregado de dados (DPO) da empresa para anomalia confirmada; segurança da informação se houver suspeita de vazamento real; plataforma para job parado.
