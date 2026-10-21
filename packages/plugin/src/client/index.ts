/**
 * dsh-plugin-adapter — browser half. Registers the IP 池 plugin card on the
 * Plugins page's `plugins.item` slot (declared at runtime by the official
 * plugin manager), keyed by the `ip-pool` namespace this plugin's Host half
 * registers.
 *
 * Configuration rides the OFFICIAL shared form
 * (ctx.configForms.get('ip-pool')): the 0.2.0 host serves every registered
 * namespace, so no compat layer. Runtime state + probe actions ride the
 * plugin's own bridge. Follows the official 0.2.0-rc.2 settings pages
 * (@deepseek-ai/dsh-client-ui-settings-agent-loop) exactly: fiber inject
 * ["slots", "locale", "configForms"], a staged controller whose inject face
 * is { hooks, ...actions }, and a whileServed-wrapped plugins.item
 * registration — whileServed hides the card when the host does not serve
 * the namespace.
 *
 * Export discipline: cross-plugin collaboration goes through cordis services
 * (`slots`, `locale`, `configForms`); the bundle purity gate forbids value
 * imports of other @deepseek-ai packages (type-only imports are erased).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer plugin's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings domain's Context merge (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { IpPoolCard } from './IpPoolCard.tsx'
import { IpPoolCardController } from './IpPoolCard.tsx'
import type { IpPoolCardFace, IpPoolCardState, IpPoolSettingsValue } from './IpPoolCard.tsx'
import { en, zh, type IpPoolKey } from './locales.ts'

export type { IpPoolCardFace, IpPoolCardProps, IpPoolCardState, IpPoolSettingsValue } from './IpPoolCard.tsx'
export type { IpPoolKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The IP 池 card copy. */
    'settings.ip-pool': IpPoolKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.ip-pool'

/** The settings namespace this card edits (mirrors the Host half). */
const SETTINGS_NS = 'ip-pool'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the IP 池 settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-adapter: copy dictionaries')

  const card = new IpPoolCardController(ctx.configForms.get<IpPoolSettingsValue>(SETTINGS_NS))
  ctx.effect(() => () => {
    card.dispose()
  }, 'dsh-plugin-adapter: form subscription')

  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: SETTINGS_NS,
    order: 30,
    label: () => t('title'),
    locale: NS,
    inject: () => card.inject(),
  }, IpPoolCard))), 'dsh-plugin-adapter: settings page')
}
