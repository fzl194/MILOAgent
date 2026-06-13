import { create } from 'zustand'

export type Theme = 'dark' | 'light'

const KEY = 'da-theme'

function readStored(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'dark'
  } catch {
    return 'dark'
  }
}

function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t
}

// Apply once on module load so the very first paint already matches the stored
// theme (no dark→light flash).
applyTheme(readStored())

interface ThemeState {
  theme: Theme
  toggle: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStored(),
  toggle: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* ignore quota / privacy mode */
    }
    set({ theme: next })
  }
}))
