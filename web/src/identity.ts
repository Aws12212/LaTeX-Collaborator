// Who you appear as to collaborators. Kept in localStorage; there are no
// accounts yet.
export interface Identity {
  name: string
  color: string
}

const STORAGE_KEY = 'collab-tex:identity'
const COLORS = ['#2f5da8', '#d9731f', '#2e8b57', '#a23b72', '#6b4fbb', '#b07d12', '#c0392b', '#1a8a8a']

export function loadIdentity(): Identity {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (stored && typeof stored.name === 'string' && typeof stored.color === 'string') {
      return { name: stored.name, color: stored.color }
    }
  } catch {
    // Unreadable or blocked storage: fall through to a fresh identity.
  }
  return {
    name: `Guest ${100 + Math.floor(Math.random() * 900)}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }
}

export function saveIdentity(identity: Identity): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  } catch {
    // Storage may be unavailable (private window); the identity just won't persist.
  }
}
