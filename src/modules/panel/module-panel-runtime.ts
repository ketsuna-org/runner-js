/**
 * Branchement du panneau de config des modules sur discord.js : reconnaît la commande de config et
 * les `custom_id` `mcfg:`, vérifie « Gérer le serveur » à chaque interaction, applique les écritures
 * (variables de serveur) et répond en Components V2. Aucune erreur interne n'est jamais montrée.
 */
import type { Interaction } from 'discord.js';
import { PANEL_FLAGS, handlePanelInteraction, panelLanguageFor, panelStringsLanguage, parsePanelId, ps } from './module-panel.js';
import { automationsOpen, handleAutomationInteraction, type PanelAutomationApi } from './module-panel-automations.js';
import { panelAutomationApiFor } from './managed-automation-api.js';

interface PanelStore {
  getScopedVariable(botId: string, scope: string, contextId: string, key: string): Promise<unknown>;
  setScopedVariable(botId: string, scope: string, contextId: string, key: string, value: unknown): Promise<void>;
}

const t = (lang: string, key: string): string => ps(lang, key);

export const panelLanguage = (locale: string | null | undefined): string => panelStringsLanguage(locale);

const notice = (content: string) => ({
  flags: PANEL_FLAGS,
  components: [{ type: 17, components: [{ type: 10, content }] }],
});

export interface PanelRuntimeContext {
  botId: string;
  config: {
    modules?: Record<string, unknown>;
    moduleConfigCommand?: Record<string, unknown>;
    translations?: Record<string, unknown>;
  };
  store: PanelStore;
  log: (message: string) => void;
  /** Accès au Manager pour l'écran « Alertes » ; absent = écran masqué. Par défaut: celui du runner géré. */
  automations?: PanelAutomationApi | null;
}

/** Renvoie vrai si l'interaction appartient au panneau (le routeur ne doit alors rien faire d'autre). */
export async function tryHandlePanel(interaction: Interaction, ctx: PanelRuntimeContext): Promise<boolean> {
  const anyI = interaction as any;
  const is = (method: string): boolean => typeof anyI[method] === 'function' && anyI[method]() === true;
  let customId = '';
  let opening = false;
  let openModule = '';
  if (is('isModalSubmit') || is('isMessageComponent')) {
    customId = String(anyI.customId ?? '');
    if (!customId.startsWith('mcfg:')) return false;
  } else if (is('isChatInputCommand')) {
    const name = String(ctx.config.moduleConfigCommand?.name ?? '');
    if (name === '' || anyI.commandName !== name) return false;
    opening = true;
    openModule = anyI.options?.getString?.('module') ?? '';
  } else {
    return false;
  }

  const lang = panelLanguageFor(anyI.locale, String(ctx.config.translations?.defaultLocale ?? ''));
  const reply = async (payload: object) => {
    if (opening || !(anyI.isFromMessage?.() ?? is('isMessageComponent'))) {
      await anyI.reply(payload);
    } else {
      await anyI.update(payload);
    }
  };
  try {
    if (!interaction.guildId) {
      await anyI.reply(notice(t(lang, 'guild')));
      return true;
    }
    if (!anyI.memberPermissions?.has?.('ManageGuild')) {
      await anyI.reply(notice(t(lang, 'denied')));
      return true;
    }
    const guildId = interaction.guildId;
    const id = opening ? (openModule === '' ? 'mcfg:home::0' : `mcfg:module:${openModule}:0`) : customId;
    const modal: Record<string, string> = {};
    if (is('isModalSubmit')) {
      anyI.fields.fields.forEach((field: any, key: string) => {
        const v = Array.isArray(field.values) ? field.values.join(',') : field.value;
        if (v != null) modal[String(key)] = String(v);
      });
    }
    const messageValues = is('isMessageComponent') && 'values' in anyI ? [...(anyI.values ?? [])].map(String) : [];
    const api = ctx.automations === undefined ? panelAutomationApiFor(ctx.botId) : ctx.automations;
    const parsed = parsePanelId(id);
    let result;
    if (api && parsed?.view === 'auto') {
      result = await handleAutomationInteraction({
        api,
        guildId,
        actorId: String(anyI.user?.id ?? anyI.member?.user?.id ?? ''),
        step: parsed.module,
        arg: parsed.arg,
        language: lang,
        modal,
      });
    } else {
      let showAlerts = false;
      if (api && parsed?.view === 'home') {
        try {
          showAlerts = automationsOpen(await api.list(guildId));
        } catch {
          showAlerts = false;
        }
      }
      result = await handlePanelInteraction({
        doc: { modules: ctx.config.modules ?? {} },
        customId: id,
        read: async (variable) => {
          const v = await ctx.store.getScopedVariable(ctx.botId, 'guild', guildId, variable);
          return v === undefined || v === null ? null : String(v);
        },
        language: lang,
        values: messageValues,
        modal,
        automations: showAlerts,
      });
    }
    for (const w of result.writes) {
      await ctx.store.setScopedVariable(ctx.botId, 'guild', guildId, w.variable, w.value);
    }
    if (result.modal) {
      await anyI.showModal(result.modal);
    } else if (result.message) {
      await reply(result.message);
    }
  } catch (error) {
    ctx.log(`Panneau de config: ${error instanceof Error ? error.message : String(error)}`);
    try {
      if (!anyI.replied && !anyI.deferred) await anyI.reply(notice(t(lang, 'failed')));
    } catch {
      // Rien de plus à faire.
    }
  }
  return true;
}
