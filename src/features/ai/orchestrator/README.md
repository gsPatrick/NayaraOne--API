# orchestrator
AiOrchestrator: orquestra o run.

## Identidade e escopo da NAY (M9-D017)

- `executionContext.js`: em nome de quem a NAY age (`USER` do token ou `SERVICE` da identidade de serviço). Permissão efetiva = interseção entre as permissões do ator e as das tools da allowlist do agente.
- `toolAuthorizer.js`: as cinco verificações de cada tool call, nesta ordem, parando na primeira falha: allowlist, permissão, entidade da empresa (sob RLS), schema dos argumentos (D018) e pedido de segredo. Falha = linha BLOCKED, evento `ai.tool_call.blocked` e erro (`AI_TOOL_NOT_ALLOWED` 403, `AI_PERMISSION_DENIED` 403, `AI_CROSS_COMPANY_BLOCKED` 404, `AI_TOOL_ARGS_*` 400, `AI_SECRET_REQUEST_BLOCKED` 403).
- `toolCallPipeline.js`: `runToolCall` é o caminho que o orquestrador usa para cada tool pedida pelo modelo (conexão restrita, autorização, executor).
- `securityRecorder.js`: grava a linha na porta `toolCallStore` (ai.tool_calls, D006), a auditoria da tentativa bloqueada (trecho redigido) e o evento no outbox, na mesma transação.
- `runtimeConnection.js`: recusa conexão de superusuário, dono ou com BYPASSRLS (`AI_CONNECTION_NOT_ALLOWED`).
- Parâmetros: `ia.seguranca.*` (aba IA NAY). Identidades de serviço: `../serviceIdentities/` (`/v1/ai/service-identities`, só leitura).
