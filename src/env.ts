/**
 * The client's options, from the environment the stdio entry passes in: trimmed,
 * and a blank value counts as unset. An MCP client's config often sets a variable
 * blank, or pastes a key with spaces around it. Passed through, a blank base URL
 * failed every call as a RETRYABLE `network` error, so a model kept retrying a
 * call that could never succeed, and a padded key went out as `Bearer  <key>`.
 */
export function clientOptions(env: Record<string, string | undefined>): { apiKey?: string; baseUrl?: string } {
    const apiKey = (env['INTERNETDATA_API_KEY'] ?? '').trim();
    const baseUrl = (env['INTERNETDATA_BASE_URL'] ?? '').trim();
    return {
        ...(apiKey === '' ? {} : { apiKey: apiKey }),
        ...(baseUrl === '' ? {} : { baseUrl: baseUrl }),
    };
}
