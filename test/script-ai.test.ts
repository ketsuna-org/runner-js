import { afterEach, describe, expect, it } from 'bun:test';

import { AiGatewayError, ManagedAiGateway, setAiGateway } from '../src/ai/ai-gateway.js';
import type { AiGateway, AiReply } from '../src/ai/ai-gateway.js';
import { ScriptExecutor } from '../src/scripts/script-executor.js';

const logger = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function fakeGateway(replies: AiReply[], failWith?: string) {
  const calls: Array<{ fn: string; messages: unknown[]; tools?: unknown[]; maxTokens?: number; key: string }> = [];
  const gateway: AiGateway = {
    async complete(request) {
      if (failWith) {
        throw new AiGatewayError(failWith);
      }
      calls.push(request);
      return replies[Math.min(calls.length - 1, replies.length - 1)]!;
    },
    async remainingTokens() {
      return 2500;
    },
  };
  return { gateway, calls };
}

async function run(script: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const executor = new ScriptExecutor(5000);
  try {
    return await executor.execute(
      script,
      {
        client: { user: { id: '42' } } as never,
        config: { token: 'x' } as never,
        variables: {},
        guild: { name: 'Home' } as never,
        channel: { name: 'general' } as never,
        ...extra,
      } as never,
      logger,
    );
  } finally {
    executor.dispose();
  }
}

afterEach(() => setAiGateway(null));

describe('bc.ai', () => {
  it('is unavailable without a gateway and the script goes on', async () => {
    expect(await run(`return [await bc.ai.ask('hi'), bc.ai.error, await bc.ai.decide('x', 'y'), await bc.ai.quota()]`)).toEqual([
      '',
      'ai_unavailable',
      false,
      0,
    ]);
  });

  it('ask sends prompt, system prompt and token limit', async () => {
    const { gateway, calls } = fakeGateway([{ content: ' Seven ', toolCalls: [] }]);
    setAiGateway(gateway);
    expect(await run(`return await bc.ai.ask('2+5?', { system: 'You are a math teacher', maxTokens: 50 })`)).toBe('Seven');
    expect(calls[0]!.fn).toBe('ai');
    expect(calls[0]!.maxTokens).toBe(50);
    expect(calls[0]!.messages).toEqual([
      { role: 'system', content: 'You are a math teacher' },
      { role: 'user', content: '2+5?' },
    ]);
  });

  it('askWithContext adds the channel and server', async () => {
    const { gateway, calls } = fakeGateway([{ content: 'hey', toolCalls: [] }]);
    setAiGateway(gateway);
    await run(`return await bc.ai.askWithContext('hello', { system: 'Be casual' })`, {
      message: { content: 'Hello there', author: { username: 'ana', id: '7' } },
    });
    const system = (calls[0]!.messages[0] as { content: string }).content;
    expect(system).toContain('Author: ana 7');
    expect(system).toContain('Channel: general');
    expect(system).toContain('Server: Home');
    expect(system).toContain('Message: Hello there');
    expect(system.endsWith('Be casual')).toBe(true);
  });

  it('decide and quota', async () => {
    setAiGateway(fakeGateway([{ content: 'True', toolCalls: [] }]).gateway);
    expect(await run(`return [await bc.ai.decide('What time?', 'A question?'), await bc.ai.decideWithContext('Rude?'), await bc.ai.quota()]`)).toEqual([
      true,
      true,
      2.5,
    ]);
  });

  it('a failure fills bc.ai.error and returns the fallback', async () => {
    setAiGateway(fakeGateway([], 'ai_insufficient_tokens').gateway);
    expect(await run(`const a = await bc.ai.ask('hi'); return [a, bc.ai.error]`)).toEqual(['', 'ai_insufficient_tokens']);
  });

  it('agent runs listed tools and bot functions, then answers', async () => {
    const { gateway, calls } = fakeGateway([
      {
        content: '',
        toolCalls: [
          { id: 't1', function: { name: 'shout', arguments: '{"text":"a;b"}' } },
          { id: 't2', function: { name: 'twice', arguments: '{"args":["x"]}' } },
          { id: 't3', function: { name: 'ban', arguments: '{}' } },
        ],
      },
      { content: 'Done', toolCalls: [] },
    ]);
    setAiGateway(gateway);
    const result = await run(`
      return await bc.ai.agent('go', {
        tools: { shout: { description: 'Uppercases', run: ({ text }) => text.toUpperCase() } },
        functions: ['twice'],
      })`, {
      config: { token: 'x', jsFunctions: [{ id: '1', name: 'twice', params: ['v'], script: 'return v + v;', enabled: true }] },
    });
    expect(result).toBe('Done');
    expect(calls).toHaveLength(2);
    expect((calls[0]!.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['shout', 'twice']);
    const tools = (calls[1]!.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => m.content);
    expect(tools).toEqual(['A;B', 'xx', 'Error: function ban is not available.']);
  });

  it('agent stops after 10 iterations with the last assistant message', async () => {
    const { gateway, calls } = fakeGateway([
      { content: 'thinking', toolCalls: [{ id: 't', function: { name: 'noop', arguments: '{}' } }] },
    ]);
    setAiGateway(gateway);
    expect(await run(`return await bc.ai.agent('go', { tools: { noop: { run: () => 'ok' } } })`)).toBe('thinking');
    expect(calls).toHaveLength(10);
  });

  it('a script that declares its own bc keeps it and still runs', async () => {
    expect(await run(`const bc = { mine: true }; return bc.mine`)).toBe(true);
  });
});

describe('ManagedAiGateway', () => {
  it('posts to the bot route with the runner token and retries once with the same key', async () => {
    const seen: Array<{ url: string; auth: string | null; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('Authorization'), body: String(init.body) });
      return seen.length === 1
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify({ message: { content: 'Seven' }, remaining_tokens: 970 }), { status: 200 });
    }) as unknown as typeof fetch;
    const gateway = new ManagedAiGateway({ baseUrl: 'https://api.test/internal/runners/o/', token: 'tok', fetchImpl });
    const reply = await gateway.complete({ botId: '42', key: 'k', fn: 'ai', messages: [{ role: 'user', content: 'hi' }] });
    expect(reply.content).toBe('Seven');
    expect(seen[0]!.url).toBe('https://api.test/internal/runners/o/bots/42/ai/complete');
    expect(seen[0]!.auth).toBe('Bearer tok');
    expect(seen[1]!.body).toBe(seen[0]!.body);
  });

  it('keeps the Manager error code', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ code: 'ai_consent_required' }), { status: 403 })) as unknown as typeof fetch;
    const gateway = new ManagedAiGateway({ baseUrl: 'https://api.test', token: 't', fetchImpl });
    await expect(gateway.remainingTokens('1')).rejects.toMatchObject({ code: 'ai_consent_required' });
  });

  it('is installed only with a managed environment', () => {
    expect(ManagedAiGateway.install({ managedRunnerApi: '', managedRunnerToken: '' })).toBe(false);
    expect(ManagedAiGateway.install({ managedRunnerApi: 'https://x', managedRunnerToken: 't' })).toBe(true);
  });
});
