import type { User } from "../../../core/types"

/** Circular monogram - the account has no avatar in the vast majority of cases. */
export function UserAvatar({ user, size = 40 }: { user: User; size?: number }) {
  const name = user.display_name || user.username || user.email
  const initials = name.trim().slice(0, 2).toUpperCase()
  return user.avatar_url ? (
    <img
      src={user.avatar_url}
      alt=""
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-primary-light font-medium text-primary"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials}
    </span>
  )
}
