export async function runAccountDeletionPreflight<TContext, TResponse>(options: {
  verifySchema: () => Promise<void>;
  authorize: () => Promise<
    | { ok: true; context: TContext }
    | { ok: false; response: TResponse }
  >;
  enforceRateLimit: () => Promise<TResponse | null>;
}) {
  await options.verifySchema();
  const authorization = await options.authorize();
  if (!authorization.ok) {
    return {
      ok: false as const,
      response: authorization.response,
    };
  }
  const limited = await options.enforceRateLimit();
  if (limited) {
    return {
      ok: false as const,
      response: limited,
    };
  }
  return {
    ok: true as const,
    context: authorization.context,
  };
}
