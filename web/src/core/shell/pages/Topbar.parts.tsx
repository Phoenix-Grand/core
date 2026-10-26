import { useTranslation } from 'react-i18next'
/**
 * The parts of `Topbar.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Link } from "react-router-dom"
import { LogOut, User as UserIcon, HelpCircle, Info, UserPlus, ExternalLink } from "lucide-react"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import * as Avatar from "@radix-ui/react-avatar"
import { Slot } from "../../slots/SlotRegistry"
import { type LinkedAccount } from "../../store/linkedAccountsStore"
import type { Topbar } from './Topbar'
function accountInitials(displayName: string | null, email: string): string {
  if (displayName) return displayName.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
  return email.slice(0, 2).toUpperCase()
}

function accountLabel(account: LinkedAccount): string {
  return account.display_name ?? account.email
}

function openLinkedAccount(account: LinkedAccount) {
  window.open(account.instance_url, '_blank', 'noopener,noreferrer')
}

export function Part1() {
  const { t: translate } = useTranslation()
  return (
    <input
                type="search"
                placeholder={translate('shared_ui.search_kubuno')}
                className="w-full pl-9 pr-10 py-2 bg-surface-2 rounded-full text-sm text-text-primary
                           placeholder-text-tertiary border border-transparent
                           focus:outline-none focus:bg-white focus:border-border focus:shadow-sm transition-all"
              />
  )
}

export function Part2({ SettingsButtonOverride }: { SettingsButtonOverride: NonNullable<Topbar['SettingsButtonOverride']> }) {
  return (
    <SettingsButtonOverride />
  )
}

export function Part3() {
  const { t: translate } = useTranslation()
  return (
    <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="w-9 h-9 rounded-full flex items-center justify-center text-text-secondary
                                   hover:bg-surface-2 transition-colors">
                  <HelpCircle size={20} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={8}
                  className="min-w-48 bg-white rounded-[5px] shadow-lg border border-border py-1 z-50"
                >
                  <Slot name="help-menu-items" />
                  <DropdownMenu.Item asChild>
                    <Link
                      to="/about"
                      className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary
                                 hover:bg-surface-1 cursor-pointer outline-none"
                    >
                      <Info size={16} className="text-text-secondary" />
                      {translate('user.about')}</Link>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
  )
}

export function Part4({ user, user_avatar_url, initials, accounts, remove, setAddModalOpen, handleLogout }: { user: Topbar['user']; user_avatar_url: string; initials: NonNullable<Topbar['initials']>; accounts: NonNullable<Topbar['accounts']>; remove: NonNullable<Topbar['remove']>; setAddModalOpen: NonNullable<Topbar['setAddModalOpen']>; handleLogout: Topbar['handleLogout'] }) {
  const { t: translate } = useTranslation()
  return (
    <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="ml-1 rounded-full outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1">
                  <Avatar.Root className="w-8 h-8 rounded-full overflow-hidden bg-primary flex items-center justify-center">
                    {user?.avatar_url ? (
                      <Avatar.Image src={user_avatar_url} alt={user.display_name ?? user.username} className="w-full h-full object-cover" />
                    ) : null}
                    <Avatar.Fallback className="text-white text-xs font-medium">{initials}</Avatar.Fallback>
                  </Avatar.Root>
                </button>
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={8}
                  className="min-w-56 bg-white rounded-[5px] shadow-lg border border-border py-1 z-50"
                >
                  {/* Compte actif */}
                  <div className="px-3 py-2 border-b border-border">
                    <p className="text-sm font-medium text-text-primary">{user?.display_name ?? user?.username}</p>
                    <p className="text-xs text-text-tertiary">{user?.email}</p>
                  </div>

                  <DropdownMenu.Item asChild>
                    <Link to="/settings" className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary
                                                     hover:bg-surface-1 cursor-pointer outline-none">
                      <UserIcon size={16} className="text-text-secondary" />
                      {translate('shared_ui.profile')}</Link>
                  </DropdownMenu.Item>

                  <Slot name="user-menu-items" />

                  {/* Comptes liés */}
                  {accounts.length > 0 && (
                    <>
                      <DropdownMenu.Separator className="h-px bg-border my-1" />
                      <p className="px-3 pt-1 pb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wide">
                        {translate('shared_ui.other_accounts')}</p>
                      {accounts.map((account) => (
                        <div key={account.id} className="group flex items-center px-3 py-1.5 gap-2 hover:bg-surface-1">
                          <Avatar.Root className="w-7 h-7 rounded-full overflow-hidden bg-surface-3 flex items-center justify-center shrink-0">
                            {account.avatar_url ? (
                              <Avatar.Image src={account.avatar_url} alt={accountLabel(account)} className="w-full h-full object-cover" />
                            ) : null}
                            <Avatar.Fallback className="text-text-secondary text-xs font-medium">
                              {accountInitials(account.display_name, account.email)}
                            </Avatar.Fallback>
                          </Avatar.Root>
                          <div
                            className="flex-1 min-w-0 cursor-pointer"
                            onClick={() => openLinkedAccount(account)}
                          >
                            <p className="text-sm text-text-primary truncate">{accountLabel(account)}</p>
                            <p className="text-xs text-text-tertiary truncate">{new URL(account.instance_url).hostname}</p>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => openLinkedAccount(account)}
                              className="p-1 rounded hover:bg-surface-2 text-text-tertiary"
                              title={translate('shared_ui.open_tab')}
                            >
                              <ExternalLink size={13} />
                            </button>
                            <button
                              onClick={() => remove(account.id)}
                              className="p-1 rounded hover:bg-danger-light text-text-tertiary hover:text-danger"
                              title={translate('shared_ui.remove_account')}
                            >
                              <LogOut size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}

                  <DropdownMenu.Separator className="h-px bg-border my-1" />

                  {/* Ajouter un compte */}
                  <DropdownMenu.Item
                    onSelect={() => setAddModalOpen(true)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary
                               hover:bg-surface-1 cursor-pointer outline-none"
                  >
                    <UserPlus size={16} className="text-text-secondary" />
                    {translate('shell.add_account')}</DropdownMenu.Item>

                  <DropdownMenu.Separator className="h-px bg-border my-1" />

                  <DropdownMenu.Item
                    onSelect={handleLogout}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-danger
                               hover:bg-danger-light cursor-pointer outline-none"
                  >
                    <LogOut size={16} />
                    {translate('user.logout')}</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
  )
}
