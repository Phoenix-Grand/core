/** Shared password strength heuristic - used by the sign-up form and the forced
 *  password change screen so both show the exact same meter. */
export interface PasswordStrength {
  score: number
  /** i18n key describing the score. */
  key: string
  color: string
}

export function passwordStrength(password: string): PasswordStrength {
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[A-Z]/.test(password)) score++
  if (/[0-9]/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++

  if (score <= 1) return { score, key: 'register.s_very_weak', color: '#d93025' }
  if (score === 2) return { score, key: 'register.s_weak', color: '#f9ab00' }
  if (score === 3) return { score, key: 'register.s_medium', color: '#f9ab00' }
  if (score === 4) return { score, key: 'register.s_strong', color: '#1e8e3e' }
  return { score, key: 'register.s_very_strong', color: '#1e8e3e' }
}
