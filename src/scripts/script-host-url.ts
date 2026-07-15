import type { ModuleRegistry } from './script-host-modules.js';

const URL_METHODS = ['toString', 'toJSON'] as const;
const URL_SEARCH_PARAMS_METHODS = [
  'append',
  'delete',
  'entries',
  'forEach',
  'get',
  'getAll',
  'has',
  'keys',
  'set',
  'sort',
  'toString',
  'values',
] as const;

function urlSnapshot(value: URL): Record<string, unknown> {
  return {
    href: value.href,
    origin: value.origin,
    protocol: value.protocol,
    username: value.username,
    password: value.password,
    host: value.host,
    hostname: value.hostname,
    port: value.port,
    pathname: value.pathname,
    search: value.search,
    hash: value.hash,
  };
}

export function buildUrlModule(wrapHostResult: ModuleRegistry['wrapHostResult']) {
  return {
    URL: (input: string, base?: string) =>
      wrapHostResult(new URL(input, base), 'url-instance', URL_METHODS, (value) =>
        urlSnapshot(value as URL),
      ),
    URLSearchParams: (init?: string | Record<string, string>) =>
      wrapHostResult(
        new URLSearchParams(init as never),
        'url-search-params',
        URL_SEARCH_PARAMS_METHODS,
        () => ({}),
      ),
  };
}
