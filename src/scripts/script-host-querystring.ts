import { parse, stringify } from 'node:querystring';

export function buildQuerystringModule() {
  return {
    parse: (text: string) => parse(text),
    stringify: (object: Parameters<typeof stringify>[0]) => stringify(object),
  };
}
