/**
 * The five keys of migration `000110` and the six of `000114`, and the card
 * each one belongs to.
 *
 * Kept apart from the components so that the page's contents are a *list* an
 * operator can read at a glance, and so that adding a governed field is one
 * entry here rather than a new block of markup.
 *
 * Every key below is enforced server-side — `crate::settings::directory`,
 * called from `handlers::users::{update_me, upload_avatar, search_users,
 * lookup_users}`. That is not a decorative remark: this console has shipped
 * per-unit switches that resolved correctly and governed nothing, and a screen
 * that offers a scope bar is promising the value will be applied at that scope.
 * A key added here without a reader on the other side would restore exactly
 * that defect.
 */

export const DIR_ENABLED       = 'directory.enabled'
export const DIR_SHARE_EMAIL   = 'directory.share_email'
export const DIR_AUDIENCE      = 'directory.audience'
export const DIR_EDIT_NAME     = 'directory.profile_edit_name'
export const DIR_EDIT_PHOTO    = 'directory.profile_edit_photo'

// Migration `000114`. Each one has a column on `core.users`, a variant of
// `settings::directory::ProfileField`, and a check in `handlers::users::update_me`
// — in that order, which is the order this file's rule below demands.
export const DIR_EDIT_NAME_PRONUNCIATION = 'directory.profile_edit_name_pronunciation'
export const DIR_EDIT_PRONOUNS           = 'directory.profile_edit_pronouns'
export const DIR_EDIT_WORK_LOCATION      = 'directory.profile_edit_work_location'
export const DIR_EDIT_INTRODUCTION       = 'directory.profile_edit_introduction'
export const DIR_EDIT_GENDER             = 'directory.profile_edit_gender'
export const DIR_EDIT_BIRTHDAY           = 'directory.profile_edit_birthday'

/** Booleans painted as toggles, in the "sharing" card. */
export const SHARING_KEYS = [DIR_ENABLED, DIR_SHARE_EMAIL] as const

/**
 * Booleans painted as checkboxes, in the "profile editing" card.
 *
 * Ordered as the profile page orders the boxes themselves — identity first,
 * then the two personal fields — so an operator closing "birthday" is looking
 * at the same sequence the person whose profile it is will see.
 */
export const PROFILE_KEYS = [
  DIR_EDIT_NAME,
  DIR_EDIT_PHOTO,
  DIR_EDIT_NAME_PRONUNCIATION,
  DIR_EDIT_PRONOUNS,
  DIR_EDIT_WORK_LOCATION,
  DIR_EDIT_INTRODUCTION,
  DIR_EDIT_GENDER,
  DIR_EDIT_BIRTHDAY,
] as const

/**
 * The two personal fields, called out so the card can mark them.
 *
 * The mark is not a warning about the switch — these are governed exactly like
 * the other six. It says where the datum goes: onto the person's own profile
 * and onto their administration sheet, and nowhere else. Neither is ever
 * returned by `/users/search` or `/users/lookup`, so no people picker in any
 * module can show them, whatever these keys are set to.
 */
export const PERSONAL_DATA_KEYS: readonly string[] = [DIR_EDIT_GENDER, DIR_EDIT_BIRTHDAY]

/**
 * What the comparable consoles govern that this instance still does not store.
 *
 * One row left. It is listed on the screen as an inert line, not as a switch —
 * a deliberate middle path between two bad options: hiding it makes the page
 * impossible to compare with the console it is modelled on, while offering a
 * real checkbox would govern a column `core.users` does not have, which is the
 * decorative-setting defect this whole page exists to avoid.
 *
 * `other_personal_info` stays because it is a catch-all with no defined
 * content: there is nothing to add a column *for*. The six real fields left this
 * list with migration `000114`, and `profile_discovery` left it for a different
 * reason — see `DirectorySettingsSection`: it is a visibility control, not a
 * profile field, and this instance already answers it, more finely, with
 * `directory.enabled` and `directory.audience`.
 *
 * Adding one for real means three things, in this order: a column on
 * `core.users`, a reader in `crate::settings::directory`, then moving its
 * identifier from this list into `PROFILE_KEYS`. Until the first two exist, it
 * stays here.
 */
export const PROFILE_FIELDS_NOT_STORED = [
  'other_personal_info',
] as const

/** The closed value set of `directory.audience`, in the order it is offered. */
export const AUDIENCE_OPTIONS = ['all_members', 'same_unit'] as const
export type AudienceValue = (typeof AUDIENCE_OPTIONS)[number]

/** Everything this page governs — used to tell "not migrated" from "loading". */
export const DIRECTORY_KEYS: readonly string[] = [
  ...SHARING_KEYS,
  ...PROFILE_KEYS,
  DIR_AUDIENCE,
]
