/**
 * Where a fixed popover goes, from its trigger's viewport rect (TicketPopover). Below the trigger by default, flipped
 * above when the room below is smaller than the panel and there is more room above; aligned to the trigger's left or
 * right edge, then shifted so it stays `margin` px inside the viewport; `maxHeight` is the room on the chosen side (the
 * panel scrolls inside it).
 */
export interface PopoverPlacement {
  top: number
  left: number
  maxHeight: number
  side: 'below' | 'above'
}

export function placePopover(input: {
  trigger: { top: number; bottom: number; left: number; right: number; width: number }
  panel: { width: number; height: number }
  viewport: { width: number; height: number }
  /** `auto`: grow away from the nearer viewport edge (right-aligned when the trigger sits in the right half). */
  align: 'left' | 'right' | 'auto'
  gap?: number
  margin?: number
}): PopoverPlacement {
  const gap = input.gap ?? 6
  const margin = input.margin ?? 8
  const { trigger, panel, viewport } = input
  const below = viewport.height - trigger.bottom - gap - margin // float-ok: not money (UI layout margin in px)
  const above = trigger.top - gap - margin
  const side: 'below' | 'above' = panel.height > below && above > below ? 'above' : 'below'
  const room = Math.max(80, side === 'below' ? below : above)
  const height = Math.min(panel.height, room)
  const top = side === 'below' ? trigger.bottom + gap : trigger.top - gap - height
  const width = Math.min(panel.width, viewport.width - margin * 2) // float-ok: not money (UI layout margin in px)
  const align = input.align === 'auto' ? (trigger.left + trigger.width / 2 > viewport.width / 2 ? 'right' : 'left') : input.align
  let left = align === 'right' ? trigger.right - width : trigger.left
  left = Math.min(left, viewport.width - margin - width) // float-ok: not money (UI layout margin in px)
  left = Math.max(left, margin)
  return { top: Math.round(top), left: Math.round(left), maxHeight: Math.floor(room), side }
}
