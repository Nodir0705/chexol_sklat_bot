import { useEffect } from 'react'

export interface TgUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready: () => void
        expand: () => void
        close: () => void
        initData: string
        initDataUnsafe: { user?: TgUser }
        colorScheme: 'light' | 'dark'
        themeParams: {
          bg_color?: string
          text_color?: string
          hint_color?: string
          button_color?: string
          button_text_color?: string
          secondary_bg_color?: string
        }
        MainButton: {
          text: string
          show: () => void
          hide: () => void
          setText: (t: string) => void
          onClick: (cb: () => void) => void
          offClick: (cb: () => void) => void
          enable: () => void
          disable: () => void
          showProgress: (leaveActive?: boolean) => void
          hideProgress: () => void
        }
        BackButton: {
          isVisible: boolean
          show: () => void
          hide: () => void
          onClick: (cb: () => void) => void
          offClick: (cb: () => void) => void
        }
        HapticFeedback: {
          impactOccurred: (style: 'light' | 'medium' | 'heavy') => void
          notificationOccurred: (type: 'error' | 'success' | 'warning') => void
          selectionChanged: () => void
        }
      }
    }
  }
}

const tg = (() => {
  const w = window.Telegram?.WebApp
  if (w) {
    w.ready()
    w.expand()
  }
  return w ?? null
})()

export function useTelegram() {
  const user = tg?.initDataUnsafe?.user ?? null
  return {
    tg,
    user,
    userId: user?.id ?? 0,
    userName: user?.first_name ?? 'Guest',
    colorScheme: tg?.colorScheme ?? 'light',
  }
}

/** Show the Telegram MainButton and hide it on unmount. */
export function useMainButton(label: string, onClick: () => void, enabled = true) {
  useEffect(() => {
    if (!tg) return
    tg.MainButton.setText(label)
    tg.MainButton.onClick(onClick)
    if (enabled) {
      tg.MainButton.enable()
      tg.MainButton.show()
    } else {
      tg.MainButton.disable()
    }
    return () => {
      tg.MainButton.offClick(onClick)
      tg.MainButton.hide()
    }
  }, [label, onClick, enabled])
}

/** Show the Telegram BackButton and hide it on unmount. */
export function useBackButton(onBack: (() => void) | null) {
  useEffect(() => {
    if (!tg || !onBack) return
    tg.BackButton.show()
    tg.BackButton.onClick(onBack)
    return () => {
      tg.BackButton.offClick(onBack)
      tg.BackButton.hide()
    }
  }, [onBack])
}

export function haptic(type: 'light' | 'medium' | 'heavy' | 'success' | 'error' = 'light') {
  if (!tg) return
  if (type === 'success' || type === 'error') {
    tg.HapticFeedback.notificationOccurred(type)
  } else {
    tg.HapticFeedback.impactOccurred(type)
  }
}
