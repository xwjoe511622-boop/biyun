import { computed, shallowRef } from 'vue'

/** Resolve a translated notice with the active locale each time it is displayed. */
export function useLocalizedNotice() {
  const message = shallowRef<string | (() => string)>('')
  const text = computed({
    get: () => typeof message.value === 'function' ? message.value() : message.value,
    set: (value: string) => { message.value = value },
  })
  function set(render: () => string): void {
    message.value = render
  }
  return { text, set }
}
