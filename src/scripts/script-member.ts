import { PermissionsBitField } from 'discord.js';

/**
 * Quand la guilde n'est pas en cache (cache minimal du runner), discord.js
 * expose `interaction.member` sous la forme d'un APIInteractionGuildMember
 * BRUT : `permissions` y est une chaîne (bitfield décimal), donc
 * `member.permissions.has(...)` plante. Les scripts sont écrits « à la
 * discord.js » : on leur présente un vrai `PermissionsBitField`.
 */
function hasPermissionsApi(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { has?: unknown }).has === 'function'
  );
}

function toPermissionsBitField(raw: unknown): PermissionsBitField {
  try {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') {
      const text = typeof raw === 'string' ? raw.trim() : raw;
      if (text !== '') {
        return new PermissionsBitField(BigInt(text)).freeze() as PermissionsBitField;
      }
    }
  } catch {
    // valeur illisible : traitée comme « aucune permission » (fail-closed)
  }
  return new PermissionsBitField(0n).freeze() as PermissionsBitField;
}

/**
 * Renvoie le membre tel quel s'il expose déjà `permissions.has` (GuildMember),
 * sinon un proxy non mutant dont `permissions` est un `PermissionsBitField`
 * (les autres propriétés — `roles`, `user`, … — restent celles du membre brut).
 */
export function normalizeScriptMember<M>(member: M): M {
  if (typeof member !== 'object' || member === null) {
    return member;
  }
  const raw = (member as { permissions?: unknown }).permissions;
  if (hasPermissionsApi(raw)) {
    return member;
  }
  const permissions = toPermissionsBitField(raw);
  return new Proxy(member as object, {
    get(target, property) {
      if (property === 'permissions') {
        return permissions;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as M;
}

/**
 * Vue de `target` (interaction / message) dont `member` est celui normalisé
 * (et éventuellement « amélioré » en GuildMember) que le runner donne aux
 * scripts. Le reste est délégué à l'objet d'origine, qui n'est pas modifié.
 */
export function withScriptMember<T extends object>(target: T, member: unknown): T {
  if (!target || (target as { member?: unknown }).member === member) {
    return target;
  }
  return new Proxy(target, {
    get(obj, property, receiver) {
      if (property === 'member') {
        return member;
      }
      return Reflect.get(obj, property, receiver);
    },
  });
}
