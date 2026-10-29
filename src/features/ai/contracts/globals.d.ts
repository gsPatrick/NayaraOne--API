// M9-D044 (estágio 2, typecheck): com `noResolve` o tsc confere só os arquivos de contrato listados no tsconfig;
// o que eles importam entra como `any`. Estas declarações bastam para o CommonJS desses arquivos.
declare const require: (id: string) => any;
declare const module: { exports: any };
declare const process: { env: Record<string, string | undefined> };
declare const Buffer: any;
