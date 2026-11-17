import { ref } from 'vue'

export type Theme = 'light' | 'dark'
const saved = localStorage.getItem('picat.ui.theme')
export const theme = ref<Theme>(saved === 'light' ? 'light' : 'dark')
document.documentElement.dataset.theme = theme.value

export function toggleTheme(): void {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('picat.ui.theme', theme.value)
}
