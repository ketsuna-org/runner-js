import { describe, expect, it } from 'vitest';

import {
  collectAutocompleteBindings,
  filterStaticAutocompleteChoices,
  transformCommandOptionsForDiscord,
} from '../src/discord/command-options.js';

describe('command-options', () => {
  it('maps autocomplete options for Discord registration', () => {
    const body = transformCommandOptionsForDiscord([
      {
        type: 'string',
        name: 'search',
        description: 'Search query',
        required: true,
        autocomplete: {
          enabled: true,
          mode: 'javascript',
          jsScript: 'await interaction.respond([]);',
        },
      },
    ]);

    expect(body).toHaveLength(1);
    expect(body[0]?.autocomplete).toBe(true);
    expect(body[0]?.choices).toBeUndefined();
  });

  it('collects autocomplete bindings including nested options', () => {
    const bindings = collectAutocompleteBindings('find', [
      {
        type: 'subcommand',
        name: 'user',
        description: 'User search',
        options: [
          {
            type: 'string',
            name: 'query',
            description: 'Query',
            autocomplete: {
              enabled: true,
              mode: 'javascript',
              jsScript: 'await interaction.respond([]);',
            },
          },
        ],
      },
    ]);

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      commandName: 'find',
      optionPath: ['user'],
      optionName: 'query',
    });
  });

  it('filters static autocomplete choices by query', () => {
    const choices = filterStaticAutocompleteChoices(
      {
        staticChoices: [
          { name: 'Apple', value: 'apple' },
          { name: 'Banana', value: 'banana' },
        ],
      },
      'app',
    );

    expect(choices).toEqual([{ name: 'Apple', value: 'apple' }]);
  });
});
