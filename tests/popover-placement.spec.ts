import { describe, expect, it } from 'vitest'
import { placePopover } from '@/components/futures/popover-placement'

/** 2026-09-30 owner bug: the 对手价1 menu hung off the 平仓 dialog. Fixed placement from the trigger rect. */
const viewport = { width: 1440, height: 900 }
const trigger = (left: number, top: number, width = 90, height = 32) => ({ top, bottom: top + height, left, right: left + width, width })

describe('placePopover', () => {
  it('below the trigger, left-aligned for a trigger in the left half (auto)', () => {
    expect(placePopover({ trigger: trigger(520, 400), panel: { width: 200, height: 170 }, viewport, align: 'auto' })).toMatchObject({ top: 438, left: 520, side: 'below' })
  })
  it('right-aligned for a trigger in the right half (auto)', () => {
    expect(placePopover({ trigger: trigger(820, 400), panel: { width: 200, height: 170 }, viewport, align: 'auto' }).left).toBe(710)
  })
  it('flips above when there is no room below', () => {
    const at = placePopover({ trigger: trigger(520, 800), panel: { width: 200, height: 170 }, viewport, align: 'left' })
    expect(at.side).toBe('above')
    expect(at.top).toBe(800 - 6 - 170)
  })
  it('shifts to stay 8px inside the viewport', () => {
    expect(placePopover({ trigger: trigger(5, 100, 40), panel: { width: 200, height: 100 }, viewport, align: 'right' }).left).toBe(8)
    expect(placePopover({ trigger: trigger(1400, 100, 40), panel: { width: 200, height: 100 }, viewport, align: 'left' }).left).toBe(1440 - 8 - 200)
  })
  it('caps the height to the room on the chosen side', () => {
    const at = placePopover({ trigger: trigger(100, 300), panel: { width: 200, height: 2000 }, viewport, align: 'left' })
    expect(at.maxHeight).toBe(900 - 332 - 6 - 8)
  })
})
