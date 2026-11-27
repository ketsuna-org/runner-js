/**
 * Écran « Alertes » du panneau de config (automatisations par serveur) : port TypeScript de
 * `packages/shared/lib/modules/panel/module_panel_automations.dart` (bot-creator). Mêmes entrées,
 * mêmes sorties, vérifiées par `test/fixtures/module-panel-automations-conformance.json`.
 */
import {
  panelButton as button,
  panelClip as clip,
  panelContainer as container,
  panelId,
  panelMessage as message,
  panelRow as row,
  panelSeparator as sep,
  panelText as text,
  ps,
  renderError,
  type PanelResult,
} from './module-panel.js';

type Json = Record<string, any>;

/** Clé de configuration que le Manager attend pour chaque source. */
export const AUTOMATION_SOURCE_KEYS: Record<string, string> = {
  rss: 'url',
  youtube: 'channel',
  twitch: 'login',
  bluesky: 'handle',
};
export const AUTOMATION_ACTIONS = ['workflow', 'message', 'both'];

/** Erreur du Manager : `code` est son code d'erreur (`automation_limit_reached`…). */
export class PanelAutomationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface PanelAutomationApi {
  list(guildId: string): Promise<Json>;
  create(body: Json): Promise<void>;
  setStatus(guildId: string, id: string, enable: boolean): Promise<void>;
  remove(guildId: string, id: string): Promise<void>;
}

/** Vrai si le propriétaire a activé les alertes ET que son offre le permet. */
export function automationsOpen(overview: Json | null | undefined): boolean {
  const view = overview?.view;
  return !!view && typeof view === 'object' && view.enabled === true && view.paid === true;
}

function kindLabel(lang: string, kind: unknown): string {
  const key = `auto.k.${kind}`;
  const t = ps(lang, key);
  return t === key ? String(kind) : t;
}

export function renderAutomations(input: Json): Json {
  const lang = String(input.language ?? 'en');
  const view: Json = input.view ?? {};
  const limits: Json = view.limits ?? {};
  const items: Json[] = [...(input.automations ?? [])];
  const page = Math.trunc(Number(input.page ?? 0));
  const perPage = 5;
  const pages = items.length === 0 ? 1 : Math.ceil(items.length / perPage);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const children: Json[] = [
    text(ps(lang, 'auto.title', { active: view.active ?? 0, max: limits.max_active_per_guild ?? 0 })),
    sep(),
  ];
  if (input.created === true) children.push(text(ps(lang, 'auto.created')));
  if (items.length === 0) children.push(text(ps(lang, 'auto.empty')));
  for (const a of items.slice(current * perPage, current * perPage + perPage)) {
    const id = String(a.id);
    const running = a.status === 'active';
    const error = String(a.last_error ?? '').trim();
    const detail = [
      kindLabel(lang, a.source_kind),
      `<#${a.channel_id}>`,
      running ? ps(lang, 'auto.running') : ps(lang, 'auto.paused'),
    ].join(' · ');
    children.push(text(`**${clip(String(a.name), 80)}**\n-# ${detail}${error === '' ? '' : `\n-# ${clip(error, 120)}`}`));
    children.push(
      row([
        button(panelId('auto', running ? 'off' : 'on', id), running ? ps(lang, 'auto.pause') : ps(lang, 'auto.start'), running ? 2 : 3),
        button(panelId('auto', 'del', id), ps(lang, 'auto.delete'), 4),
      ]),
    );
  }
  const totalInBot = Number(view.total_in_bot ?? 0);
  const maxTotal = limits.max_total_per_bot;
  const atBotLimit = typeof maxTotal === 'number' && totalInBot >= maxTotal;
  children.push(sep());
  children.push(
    row([
      button(panelId('home'), ps(lang, 'mod.home')),
      button(panelId('auto', 'list', String(current - 1)), '◀', 2, current === 0),
      button(panelId('auto', 'list', String(current + 1)), '▶', 2, current >= pages - 1),
      button(panelId('auto', 'new'), ps(lang, 'auto.new'), 1, atBotLimit),
    ]),
  );
  return message(container(0x7c5cf0, children));
}

export function renderAutomationsClosed(lang: string, paid: boolean): Json {
  return renderError(paid ? ps(lang, 'auto.closed') : ps(lang, 'auto.err.paid'), panelId('home', '', '0'), lang);
}

export function renderAutomationConfirm(automation: Json, lang: string): Json {
  return message(
    container(0xed4245, [
      text(ps(lang, 'auto.confirm', { name: clip(String(automation.name), 80) })),
      row([
        button(panelId('auto', 'list', '0'), ps(lang, 'auto.back')),
        button(panelId('auto', 'delyes', String(automation.id)), ps(lang, 'auto.confirmYes'), 4),
      ]),
    ]),
  );
}

export function renderAutomationModal(lang: string): Json {
  const label = (key: string, field: Json, description?: string): Json => ({
    type: 18,
    label: ps(lang, key),
    ...(description === undefined ? {} : { description: clip(description, 100) }),
    component: field,
  });
  return {
    title: ps(lang, 'auto.m.title'),
    custom_id: panelId('auto', 'save'),
    components: [
      label('auto.m.name', { type: 4, custom_id: 'name', style: 1, required: true, max_length: 60 }),
      label('auto.m.kind', {
        type: 3,
        custom_id: 'kind',
        options: Object.keys(AUTOMATION_SOURCE_KEYS).map((k) => ({ label: kindLabel(lang, k), value: k })),
      }),
      label(
        'auto.m.source',
        { type: 4, custom_id: 'source', style: 1, required: true, max_length: 300 },
        ps(lang, 'auto.m.sourceDesc'),
      ),
      label('auto.m.channel', { type: 8, custom_id: 'channel', channel_types: [0, 5], min_values: 1, max_values: 1 }),
      label('auto.m.action', {
        type: 3,
        custom_id: 'action',
        options: AUTOMATION_ACTIONS.map((a) => ({
          label: ps(lang, `auto.a.${a}`),
          value: a,
          ...(a === 'workflow' ? { default: true } : {}),
        })),
      }),
    ],
  };
}

/** Corps de la requête de création, ou `null` si un champ obligatoire manque. */
export function automationCreateBody(
  modal: Record<string, string>,
  guildId: string,
  actorId: string,
): Json | null {
  const first = (v: string | undefined): string => (v ?? '').split(',')[0].trim();
  const name = (modal.name ?? '').trim();
  const kind = first(modal.kind);
  const source = (modal.source ?? '').trim();
  const channel = first(modal.channel);
  let action = first(modal.action);
  if (action === '') action = 'workflow';
  const key = AUTOMATION_SOURCE_KEYS[kind];
  if (name === '' || key === undefined || source === '' || channel === '' || !AUTOMATION_ACTIONS.includes(action)) return null;
  return {
    guild_id: guildId,
    actor_id: actorId,
    name,
    source_kind: kind,
    source: { [key]: source },
    channel_id: channel,
    action,
  };
}

function errorKey(code: string): string {
  switch (code) {
    case 'automation_paid_required':
      return 'auto.err.paid';
    case 'automation_not_enabled':
      return 'auto.closed';
    case 'automation_limit_reached':
      return 'auto.err.limit';
    case 'automation_total_limit':
      return 'auto.err.total';
    case 'source_unreachable':
    case 'source_unavailable':
      return 'auto.err.source';
    case 'invalid_payload':
      return 'auto.err.invalid';
    default:
      return 'auto.err.generic';
  }
}

/** Applique une interaction `mcfg:auto:<étape>:<id>` ; `actorId` est l'auteur de l'interaction. */
export async function handleAutomationInteraction(args: {
  api: PanelAutomationApi;
  guildId: string;
  actorId: string;
  step: string;
  arg: string;
  language: string;
  modal?: Record<string, string>;
}): Promise<PanelResult> {
  const { api, guildId, actorId, step, arg, language } = args;
  const listing = async (created = false, page = 0): Promise<PanelResult> => {
    const overview = await api.list(guildId);
    const view: Json = overview.view ?? {};
    if (view.enabled !== true || view.paid !== true) {
      return { message: renderAutomationsClosed(language, view.paid === true), writes: [] };
    }
    return {
      message: renderAutomations({ language, view, automations: overview.automations ?? [], page, ...(created ? { created: true } : {}) }),
      writes: [],
    };
  };
  const failure = (code: string): PanelResult => ({
    message: renderError(ps(language, errorKey(code)), panelId('auto', 'list', '0'), language),
    writes: [],
  });
  try {
    switch (step) {
      case 'new':
        return { modal: renderAutomationModal(language), writes: [] };
      case 'save': {
        const body = automationCreateBody(args.modal ?? {}, guildId, actorId);
        if (body === null) return failure('invalid_payload');
        await api.create(body);
        return await listing(true);
      }
      case 'on':
      case 'off':
        await api.setStatus(guildId, arg, step === 'on');
        return await listing();
      case 'del': {
        const overview = await api.list(guildId);
        const target = ((overview.automations ?? []) as Json[]).find((a) => String(a.id) === arg);
        if (!target) return await listing();
        return { message: renderAutomationConfirm(target, language), writes: [] };
      }
      case 'delyes':
        await api.remove(guildId, arg);
        return await listing();
      default: {
        const n = Number.parseInt(arg, 10);
        return await listing(false, Number.isNaN(n) ? 0 : n);
      }
    }
  } catch (error) {
    if (error instanceof PanelAutomationError) return failure(error.code);
    throw error;
  }
}
