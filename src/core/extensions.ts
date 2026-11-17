import { defineAsyncComponent, type Component, type AsyncComponentLoader } from 'vue'
import { isFeatureEnabled, type FeatureFlagKey } from './feature-flags'

/**
 * Typed extension registry.
 *
 * Every optional module (short video / live / chat and future work) is registered here instead of
 * being wired into the views directly. Registrations are inert while their feature flag is `false`,
 * and the component module is only imported when the flag is enabled (lazy, no SDK bundled).
 */

export type ExtensionSlot =
  | 'header.nav'
  | 'trade.sidebar'
  | 'trade.aboveChart'
  | 'trade.belowOrderForm'
  | 'assets.sidebar'
  | 'login.aside'

export interface ExtensionRegistration {
  /** Stable unique id, e.g. `short-video-trade-rail`. */
  id: string
  slot: ExtensionSlot
  /** Feature flag that must be `true` before the module is loaded. */
  flag: FeatureFlagKey
  /** i18n key or literal label for navigation entries; omit for inline slots. */
  labelKey?: string
  /** Route path when the extension renders as a navigation entry. */
  routePath?: string
  /** Dynamic import, so the chunk is only fetched when enabled. */
  load: AsyncComponentLoader
}

const registry = new Map<string, ExtensionRegistration>()

export function registerExtension(registration: ExtensionRegistration): void {
  registry.set(registration.id, registration)
}

export function registeredExtensions(): ExtensionRegistration[] {
  return [...registry.values()]
}

export interface ResolvedExtension extends ExtensionRegistration {
  component: Component
}

/** Enabled extensions for a slot, with lazily created async components. */
export function extensionsForSlot(slot: ExtensionSlot): ResolvedExtension[] {
  return registeredExtensions()
    .filter((entry) => entry.slot === slot && isFeatureEnabled(entry.flag))
    .map((entry) => ({
      ...entry,
      component: defineAsyncComponent(entry.load),
    }))
}

/** Navigation entries contributed by enabled extensions (empty by default). */
export function extensionNavEntries(): ResolvedExtension[] {
  return extensionsForSlot('header.nav')
}
