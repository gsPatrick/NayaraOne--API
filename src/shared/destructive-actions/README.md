# destructive-actions — confirmação com impacto das ações destrutivas ou críticas (M9-D852)

Núcleo transversal (não é feature): toda ação difícil de desfazer do sistema passa pelo mesmo guarda de confirmação, com o impacto calculado pelo servidor.
O inventário fechado das ações (R34, 19 linhas do livro) é `docs/governance/destructive-actions.json`.

## Como funciona
1. `GET|POST <recurso>/impact` (`impact.handler.js`) devolve `{counts, totalAmountCents, blockers, items, impactToken, level, record:{code,codeLabel}, confirm}`. Não grava nada.
2. A ação (`POST|DELETE|PATCH`) leva `confirmation: {understood?, typedCode?, justification?, impactToken}` e passa por `confirmAction(chave)` (`guard.js`), depois da permissão e do MFA da rota.
3. O guarda recalcula o impacto na hora: impedimento é 409 `GOV_ACTION_BLOCKED`; confirmação incompleta é 422 `GOV_CONFIRMATION_REQUIRED`; token vencido, de outro registro/usuário ou de impacto diferente do atual é 409 `GOV_ACTION_IMPACT_CHANGED` (ou 422 quando o token é inválido). Nada executa em nenhum dos casos.
4. Nível 1 simples, 2 com impacto (`understood: true`), 3 crítica (`typedCode` igual ao código do registro e `justification` com o mínimo de `governanca.dlp.justificativa_min`). O nível de cada ação é o parâmetro `governanca.ui.confirmacao_por_nivel` (padrão: o do livro).
5. O `impactToken` é HMAC com validade (`governanca.acoes.impacto_validade_min`, padrão 10). A confirmação grava a auditoria `governance.action.confirmed` com a justificativa e o `correlationId` da requisição.
6. Uma chave de idempotência já usada pula a confirmação (o efeito já aconteceu): a idempotência devolve a resposta original ou 422 `GOV_IDEMPOTENCY_KEY_REUSED`.

## Como plugar uma ação nova (ou uma das ainda sem rota)
- A linha já está no inventário; mude `wired` para `true` e confirme a rota e a permissão.
- Registre o provedor de impacto com `registerProvider(chave, fn)` (`registry.js`; os atuais estão em `providers/`): devolve `{code, label, impact:{counts,totalAmountCents,blockers,items}}`, ou `{skip:true}` quando a chamada não é a ação perigosa (só fora da simulação).
- Na rota: `confirmAction('chave', {reasonField?, extraBody?, mfa?, resourceId?})` depois da permissão. A rota `/impact` é montada sozinha por `impact.routes.js` quando `impact.mount` é `central`.
- O teste `test/marco9/governanca/m9d852.inventario.test.js` reprova linha `wired` sem guarda, sem `/impact`, sem provedor ou sem MFA conferido.

## Erros
Sem stack: `errorHandler.js` devolve a frase "Algo deu errado. Informe o código <traceId> ao suporte." e `error.traceId` (igual ao `X-Correlation-Id`); o campo `debug` só existe fora de produção e com `governanca.ui.exibir_debug` ligado (`debug.policy.js`).
