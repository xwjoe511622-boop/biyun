import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { installChunkRecovery, isChunkLoadError } from '@/router/chunk-recovery'

describe('chunk recovery', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  it('recognises stale-chunk import failures across browsers', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/_lb/AssetsView-abc.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /_lb/AssetsView-x.css'))).toBe(true)
    expect(isChunkLoadError(new Error('Network Error'))).toBe(false)
  })

  it('reloads the target page once when its chunk fails, never in a loop', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    const failing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /_lb/AssetsView-old.js'))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        { path: '/assets', component: failing },
      ],
    })
    installChunkRecovery(router)
    await router.push('/')
    await router.push('/assets').catch(() => undefined)
    await router.push('/assets').catch(() => undefined)
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/assets')
  })
})
