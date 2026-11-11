import { randomUUID } from 'node:crypto';

import { AiGatewayError, getAiGateway } from '../ai/ai-gateway.js';
import { createBcActivity, createBcGrid, createBcForum, createBcLock, createBcMath, createBcVars } from './script-bc-extras.js';
import type { BcActivity, BcGrid, BcForum, BcLock, BcMath, BcVars } from './script-bc-extras.js';
import type { AiGateway, AiMessage, AiTool, AiToolCall } from '../ai/ai-gateway.js';

/** Itérations maximales de `bc.ai.agent`, comme `$aiAgent` de BDFD. */
export const AI_AGENT_MAX_ITERATIONS = 10;
const MAX_CONTEXT_REPLY = 200;
const MAX_TOOL_RESULT_CHARS = 4000;

export interface AiCallOptions {
  /** Consigne qui oriente le comportement de l'IA. */
  system?: string;
  /** Plafond de longueur de la réponse (500 par défaut, 1500 au plus côté Manager). */
  maxTokens?: number;
}

export interface AiAgentTool {
  description?: string;
  /** Schéma JSON des paramètres (par défaut : un objet libre). */
  parameters?: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface AiAgentOptions extends AiCallOptions {
  /** Outils propres à cet appel : nom → fonction. */
  tools?: Record<string, AiAgentTool>;
  /** Noms de fonctions de la bibliothèque `fn` de ce bot que l'IA peut appeler (arguments dans `args`). */
  functions?: string[];
}

export interface BcAi {
  /** Code de la dernière erreur ('' si le dernier appel a réussi). */
  readonly error: string;
  ask(prompt: string, options?: AiCallOptions): Promise<string>;
  askWithContext(prompt: string, options?: AiCallOptions): Promise<string>;
  decide(content: string, question: string): Promise<boolean>;
  decideWithContext(question: string): Promise<boolean>;
  agent(prompt: string, options?: AiAgentOptions): Promise<string>;
  /** Crédits IA restants du propriétaire du bot (1 crédit = 1000 tokens). */
  quota(): Promise<number>;
}

export interface BcAiContext {
  client?: { user?: { id?: unknown } | null; application?: { id?: unknown } | null };
  message?: unknown;
  interaction?: unknown;
  guild?: unknown;
  channel?: unknown;
  db?: unknown;
}

const DECIDE_SYSTEM =
  'Answer the yes/no question about the content. Reply with exactly one word: true or false.';

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** Identifiant Discord de l'auteur du message ou de l'interaction déclencheurs. */
function triggerUserId(context: BcAiContext): string | undefined {
  const id =
    (context.message as { author?: { id?: unknown } } | undefined)?.author?.id ??
    (context.interaction as { user?: { id?: unknown } } | undefined)?.user?.id;
  return id === undefined || id === null || id === '' ? undefined : String(id);
}

/** Contexte du message déclencheur, comme `$aiWithCtx` de BDFD. */
export function describeContext(context: BcAiContext): string {
  const message = context.message as
    | {
        content?: unknown;
        author?: { username?: unknown; id?: unknown };
        member?: { nickname?: unknown } | null;
        createdAt?: Date;
        editedAt?: Date | null;
        attachments?: { map?: (fn: (a: { name?: string }) => string) => string[] };
        reference?: unknown;
      }
    | undefined;
  const interaction = context.interaction as
    | { user?: { username?: unknown; id?: unknown }; commandName?: unknown }
    | undefined;
  const lines: string[] = [];
  const add = (label: string, value: unknown): void => {
    const rendered = text(value).trim();
    if (rendered) {
      lines.push(`${label}: ${rendered}`);
    }
  };
  const author = message?.author ?? interaction?.user;
  add('Author', [text(author?.username), text(author?.id)].filter(Boolean).join(' '));
  add('Author nickname', message?.member?.nickname);
  add('Channel', (context.channel as { name?: unknown } | null | undefined)?.name);
  add('Server', (context.guild as { name?: unknown } | null | undefined)?.name);
  add('Sent at', message?.createdAt?.toISOString?.());
  add('Edited at', message?.editedAt?.toISOString?.());
  try {
    const names = message?.attachments?.map?.((a) => text(a.name));
    add('Attachments', Array.isArray(names) ? names.join(', ') : '');
  } catch {
    // collection non itérable : ignorée
  }
  add('Message', message?.content);
  if (interaction?.commandName) {
    add('Command', interaction.commandName);
  }
  return lines.length === 0 ? '' : `Context of the Discord message that triggered the command:\n${lines.join('\n')}`;
}

function toolMessage(call: AiToolCall, content: string): AiMessage {
  return { role: 'tool', tool_call_id: call.id, content: content.slice(0, MAX_TOOL_RESULT_CHARS) };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Le global `bc` d'un script : `bc.ai.*`. [getFn] donne la bibliothèque `fn` du script en cours. */
export function createBcGlobal(
  context: BcAiContext,
  getFn: () => Record<string, (...args: unknown[]) => Promise<unknown>> | undefined,
  gateway: () => AiGateway | null = getAiGateway,
): { ai: BcAi; math: BcMath; vars: BcVars; lock: BcLock; forum: BcForum; activity: BcActivity; grid: BcGrid } {
  let lastError = '';
  const botId = (): string => text(context.client?.user?.id ?? context.client?.application?.id);

  async function call<T>(operation: (gw: AiGateway, id: string) => Promise<T>, fallback: T): Promise<T> {
    lastError = '';
    const gw = gateway();
    const id = botId();
    if (!gw || !id) {
      lastError = 'ai_unavailable';
      return fallback;
    }
    try {
      return await operation(gw, id);
    } catch (error) {
      lastError = error instanceof AiGatewayError ? error.code : 'ai_unavailable';
      return fallback;
    }
  }

  async function ask(fn: string, prompt: string, system: string, maxTokens?: number): Promise<string> {
    return call(async (gw, id) => {
      const reply = await gw.complete({
        botId: id,
        userId: triggerUserId(context),
        key: randomUUID(),
        fn,
        messages: [
          ...(system.trim() ? [{ role: 'system', content: system } as AiMessage] : []),
          { role: 'user', content: prompt },
        ],
        maxTokens: maxTokens && maxTokens > 0 ? Math.floor(maxTokens) : undefined,
      });
      return reply.content.trim();
    }, '');
  }

  const joinSystem = (...parts: string[]): string => parts.filter((part) => part.trim()).join('\n\n');
  const toBool = (answer: string): boolean => answer.toLowerCase().includes('true');

  const ai: BcAi = {
    get error(): string {
      return lastError;
    },
    ask: (prompt, options) => ask('ai', text(prompt), text(options?.system), options?.maxTokens),
    askWithContext: (prompt, options) =>
      ask('aiWithCtx', text(prompt), joinSystem(describeContext(context), text(options?.system)), options?.maxTokens),
    decide: async (content, question) =>
      toBool(await ask('aiDecide', `Content:\n${text(content)}\n\nQuestion: ${text(question)}`, DECIDE_SYSTEM, 8)),
    decideWithContext: async (question) =>
      toBool(
        await ask('aiDecideWithCtx', `Question: ${text(question)}`, joinSystem(describeContext(context), DECIDE_SYSTEM), 8),
      ),
    quota: () => call(async (gw, id) => (await gw.remainingTokens(id)) / 1000, 0),
    agent: (prompt, options) =>
      call(async (gw, id) => {
        const library = getFn();
        const handlers = new Map<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>();
        const tools: AiTool[] = [];
        const describe = (name: string, description: string, parameters?: Record<string, unknown>): void => {
          tools.push({
            name,
            description,
            parameters: parameters ?? { type: 'object', properties: {}, additionalProperties: true },
          });
        };
        for (const [name, tool] of Object.entries(options?.tools ?? {})) {
          if (/^[A-Za-z0-9_]{1,64}$/.test(name) && typeof tool?.run === 'function') {
            handlers.set(name, tool.run);
            describe(name, tool.description ?? `Runs ${name}.`, tool.parameters);
          }
        }
        for (const name of options?.functions ?? []) {
          const target = library?.[name];
          if (/^[A-Za-z0-9_]{1,64}$/.test(name) && typeof target === 'function' && !handlers.has(name)) {
            handlers.set(name, async (args) => {
              const list = Array.isArray(args.args) ? args.args : [];
              return target(...list);
            });
            describe(name, `Runs the bot function ${name} with the given arguments, in order.`, {
              type: 'object',
              properties: { args: { type: 'array', items: {}, description: `Arguments of ${name}, in order.` } },
            });
          }
        }
        const messages: AiMessage[] = [];
        const system = joinSystem(
          describeContext(context),
          text(options?.system),
          tools.length > 0
            ? 'You can call the listed functions as tools. Stop calling tools and answer when you have what you need.'
            : '',
        );
        if (system) {
          messages.push({ role: 'system', content: system });
        }
        messages.push({ role: 'user', content: text(prompt) });
        const runKey = randomUUID();
        let last = '';
        try {
          for (let i = 0; i < AI_AGENT_MAX_ITERATIONS; i++) {
            const reply = await gw.complete({
              botId: id,
              userId: triggerUserId(context),
              key: `${runKey}:${i}`,
              fn: 'aiAgent',
              messages,
              tools,
              maxTokens: options?.maxTokens,
            });
            if (reply.content.trim()) {
              last = reply.content.trim();
            }
            if (reply.toolCalls.length === 0) {
              return last;
            }
            messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls });
            for (const toolCall of reply.toolCalls) {
              const name = text(toolCall.function?.name);
              const handler = handlers.get(name);
              if (!handler) {
                messages.push(toolMessage(toolCall, `Error: function ${name} is not available.`));
                continue;
              }
              try {
                const parsed = JSON.parse(toolCall.function?.arguments || '{}') as unknown;
                const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
                messages.push(toolMessage(toolCall, stringify(await handler(args as Record<string, unknown>))));
              } catch (error) {
                messages.push(toolMessage(toolCall, `Error: ${error instanceof Error ? error.message : String(error)}`));
              }
            }
          }
        } catch (error) {
          lastError = error instanceof AiGatewayError ? error.code : 'ai_unavailable';
        }
        // Limite d'itérations atteinte (ou erreur) : le dernier message de l'assistant, comme BDFD.
        return last;
      }, ''),
  };
  return {
    ai,
    math: createBcMath(),
    vars: createBcVars(botId(), () => context.db),
    lock: createBcLock(botId()),
    forum: createBcForum(() => context.client),
    activity: createBcActivity(botId()),
    grid: createBcGrid(),
  };
}
