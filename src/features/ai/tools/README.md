# tools

ToolRegistry e as tools da NAY (M9-D016). O registro vive no servidor: o modelo só sugere `name` e `arguments`; permissão, risco e aprovação saem da definição.

- `definitions/*.js`: uma definição por arquivo (`name`, `version`, `description`, `permissionCode`, `riskLevel`, `category`, `domain`, `inputSchema`, `outputSchema`, `requiresHumanApproval`, `idempotent`, `execute(ctx, input)`). Treze tools iniciais: dez de leitura e três de escrita (proposta).
- `toolDefinition.js`: validação no boot (campo ausente, permissão que não existe em `core.permissions`, AI-007). Erro: `AI_TOOL_DEFINITION_INVALID` (500).
- `ToolRegistry.js`: registra, versiona, monta o mapa do executor (saída podada pelo `outputSchema`; escrita vira proposta por padrão) e a visão enxuta do prompt.
- `outputSchema.js`: valida e poda a saída; `AI_TOOL_OUTPUT_INVALID` se não cumpre o schema.
- `modelToolCall.js`: descarta do pedido do modelo qualquer campo além de `name` e `arguments`.
- `toolExecutor.js` (D002/D018): contexto congelado, validação de argumentos e execução.
- `bootRegistry.js`: `initToolRegistry()` no boot (app.js) contra o catálogo real de permissões. Rota `GET /v1/ai/tools` (`ai:admin`).

Tool nunca usa SQL, `sequelize` nem modelo: só `ctx.services` e `ctx.readModels` (montados em `../toolServices/`, que chamam os serviços de aplicação existentes).
