/**
 * The parts of `ProfileTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Trash2, Plus, Clock } from "lucide-react"
import { Input, Dropdown, Textarea } from "@ui"
import type { ProfileTab } from './ProfileTab'
import Field from './ProfileField'
import Section from './Section'
const PROFILE_LOCALES: [string, string][] = [
  ['fr-FR', 'French'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'],
  ['de-DE', 'German'], ['es-ES', 'Spanish'], ['it-IT', 'Italian'],
  ['pt-PT', 'Portuguese'], ['nl-NL', 'Dutch'], ['ja-JP', 'Japanese'], ['zh-CN', 'Chinese'],
]

export function Part1({ t, vis, setV, f, set, user }: { t: NonNullable<ProfileTab['tr']>; vis: NonNullable<ProfileTab['vis']>; setV: ProfileTab['setV']; f: NonNullable<ProfileTab['f']>; set: ProfileTab['set']; user: ProfileTab['user'] }) {
  return (
    <Section title={t('settings.profile_sec_identity', { defaultValue: 'Identité et coordonnées' })}>
            <Field label={t('settings.profile_full_name', { defaultValue: 'Nom complet' })} vis={vis.fullName} onVis={setV('fullName')}>
              <Input value={f.fullName} onChange={e => set('fullName', e.target.value)} />
            </Field>
    
            <Field label={t('settings.profile_first_name', { defaultValue: 'Prénom' })} vis={vis.firstName} onVis={setV('firstName')}>
              <Input value={f.firstName} onChange={e => set('firstName', e.target.value)} maxLength={120} />
            </Field>
    
            <Field label={t('settings.profile_last_name', { defaultValue: 'Nom de famille' })} vis={vis.lastName} onVis={setV('lastName')}>
              <Input value={f.lastName} onChange={e => set('lastName', e.target.value)} maxLength={120} />
            </Field>
    
            <Field label={t('settings.profile_name_pronunciation', { defaultValue: 'Prononciation du nom' })}
              vis={vis.namePronunciation} onVis={setV('namePronunciation')}
              hint={t('settings.profile_name_pronunciation_hint', { defaultValue: 'Comment prononcer votre nom, écrit à votre façon.' })}>
              <Input value={f.namePronunciation} onChange={e => set('namePronunciation', e.target.value)}
                maxLength={120}
                placeholder={t('settings.profile_name_pronunciation_ph', { defaultValue: 'Par exemple : Ma-ri-nier' })} />
            </Field>
    
            <Field label={t('settings.profile_pronouns', { defaultValue: 'Pronoms' })} vis={vis.pronouns} onVis={setV('pronouns')}>
              <Input value={f.pronouns} onChange={e => set('pronouns', e.target.value)}
                maxLength={60}
                placeholder={t('settings.profile_pronouns_ph', { defaultValue: 'Vos pronoms. Par exemple : ils/elles' })} />
            </Field>
    
            <Field
              label={t('settings.profile_email', { defaultValue: 'E-mail' })}
              vis={vis.emails} onVis={setV('emails')}
              className="md:col-span-2"
              action={<button type="button" onClick={() => set('extraEmails', [...f.extraEmails, ''])}
                className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"><Plus size={13} />{t('settings.profile_add', { defaultValue: 'Ajouter' })}</button>}
              hint={t('settings.profile_email_hint', { defaultValue: 'Adresse e-mail principale pour la réinitialisation du mot de passe et les notifications' })}
            >
              <div className="mb-2"><Input value={user?.email ?? ''} disabled /></div>
              {f.extraEmails.map((em, i) => (
                <div key={i} className="flex items-center gap-2 mb-2">
                  <div className="flex-1">
                    <Input type="email" value={em} placeholder="email@example.com"
                      onChange={e => set('extraEmails', f.extraEmails.map((x, j) => j === i ? e.target.value : x))} />
                  </div>
                  <button type="button" onClick={() => set('extraEmails', f.extraEmails.filter((_, j) => j !== i))}
                    className="text-text-tertiary hover:text-danger shrink-0"><Trash2 size={15} /></button>
                </div>
              ))}
            </Field>
    
            <Field label={t('settings.profile_phone', { defaultValue: 'Numéro de téléphone' })} vis={vis.phone} onVis={setV('phone')}>
              <Input value={f.phone} onChange={e => set('phone', e.target.value)}
                placeholder={t('settings.profile_phone_ph', { defaultValue: 'Votre numéro de téléphone' })} />
            </Field>
    
            <Field label={t('settings.profile_location', { defaultValue: 'Localisation' })} vis={vis.location} onVis={setV('location')}>
              <Input value={f.location} onChange={e => set('location', e.target.value)}
                placeholder={t('settings.profile_location_ph', { defaultValue: 'Votre ville' })} />
            </Field>
    
            <Field label={t('settings.profile_work_location', { defaultValue: 'Lieu de travail' })}
              vis={vis.workLocation} onVis={setV('workLocation')}>
              <Input value={f.workLocation} onChange={e => set('workLocation', e.target.value)}
                maxLength={160}
                placeholder={t('settings.profile_work_location_ph', { defaultValue: 'Site, bâtiment, étage, ou « télétravail »' })} />
            </Field>
    
            </Section>
  )
}

export function Part2({ t, vis, setV, f, set }: { t: NonNullable<ProfileTab['tr']>; vis: NonNullable<ProfileTab['vis']>; setV: ProfileTab['setV']; f: NonNullable<ProfileTab['f']>; set: ProfileTab['set'] }) {
  return (
    <Section title={t('settings.profile_sec_personal', { defaultValue: 'Données personnelles' })}>
            <div className="md:col-span-2 rounded-lg border border-border bg-surface-1 p-3 text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {t('settings.profile_personal_note', { defaultValue: 'Ces deux champs sont facultatifs et vous pouvez les effacer à tout moment. Ils ne figurent jamais dans l’annuaire ni dans les sélecteurs de personnes des modules : ils ne se lisent que sur votre profil et sur votre fiche d’administration.' })}
            </div>
    
            <Field label={t('settings.profile_gender', { defaultValue: 'Genre' })} vis={vis.gender} onVis={setV('gender')}
              hint={t('settings.profile_gender_hint', { defaultValue: 'Texte libre : aucune liste ne vous est imposée. Laissez vide pour ne rien indiquer.' })}>
              <Input value={f.gender} onChange={e => set('gender', e.target.value)}
                maxLength={80}
                placeholder={t('settings.profile_gender_ph', { defaultValue: 'Comme vous souhaitez le formuler' })} />
            </Field>
    
            <Field label={t('settings.profile_birthday', { defaultValue: 'Date de naissance' })} vis={vis.birthday} onVis={setV('birthday')}
              hint={t('settings.profile_birthday_hint', { defaultValue: 'Saisissez votre date de naissance' })}>
              <Input type="date" value={f.birthday} onChange={e => set('birthday', e.target.value)} />
            </Field>
            </Section>
  )
}

export function Part3({ t, labelSelect, localePreview, weekStartLabel, f, set, tz }: { t: NonNullable<ProfileTab['tr']>; labelSelect: NonNullable<ProfileTab['labelSelect']>; localePreview: NonNullable<ProfileTab['localePreview']>; weekStartLabel: NonNullable<ProfileTab['weekStartLabel']>; f: NonNullable<ProfileTab['f']>; set: ProfileTab['set']; tz: NonNullable<ProfileTab['tz']> }) {
  return (
    <Section title={t('settings.profile_sec_region', { defaultValue: 'Langue et région' })}>
            <Field label={t('settings.profile_language', { defaultValue: 'Langue' })}
              hint={<a href="https://github.com/kubuno/kubuno" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t('settings.profile_help_translate', { defaultValue: 'Aider à traduire' })}</a>}>
              {labelSelect}
            </Field>
    
            <Field label={t('settings.profile_locale', { defaultValue: 'Paramètres régionaux' })}
              hint={<><span className="flex items-center gap-1.5"><Clock size={12} />{localePreview}</span><span>{t('settings.profile_week_start', { defaultValue: 'Les semaines commencent le {{day}}', day: weekStartLabel })}</span></>}>
              <Dropdown width="100%" value={f.locale} onChange={v => set('locale', v)}
                options={[{ value: '', label: t('settings.profile_locale_auto', { defaultValue: 'Automatique' }) },
                  ...PROFILE_LOCALES.map(([value, label]) => ({ value, label }))]} />
            </Field>
    
            <Field label={t('settings.profile_first_day', { defaultValue: 'Premier jour de la semaine' })}>
              <Dropdown width="100%" value={f.firstDayOfWeek} onChange={v => set('firstDayOfWeek', v)}
                options={[
                  { value: 'auto', label: t('settings.profile_first_day_auto', { defaultValue: 'Issu de votre locale' }) },
                  { value: '1', label: t('settings.profile_week_mon', { defaultValue: 'Lundi' }) },
                  { value: '0', label: t('settings.profile_week_sun', { defaultValue: 'Dimanche' }) },
                  { value: '6', label: t('settings.profile_week_sat', { defaultValue: 'Samedi' }) },
                ]} />
            </Field>
    
            <Field label={t('settings.profile_timezone', { defaultValue: 'Fuseau horaire' })}>
              <Dropdown width="100%" value={f.timezone} onChange={v => set('timezone', v)}
                options={[{ value: '', label: t('settings.profile_locale_auto', { defaultValue: 'Automatique' }) },
                  ...tz.map(z => ({ value: z, label: z }))]} />
            </Field>
    
            </Section>
  )
}

export function Part4({ t, vis, setV, f, set }: { t: NonNullable<ProfileTab['tr']>; vis: NonNullable<ProfileTab['vis']>; setV: ProfileTab['setV']; f: NonNullable<ProfileTab['f']>; set: ProfileTab['set'] }) {
  return (
    <Section title={t('settings.profile_sec_social', { defaultValue: 'Réseaux, organisation et profil' })}>
            <Field label={t('settings.profile_website', { defaultValue: 'Site web' })} vis={vis.website} onVis={setV('website')}>
              <Input value={f.website} onChange={e => set('website', e.target.value)}
                placeholder={t('settings.profile_website_ph', { defaultValue: 'Votre site web' })} />
            </Field>
    
            <Field label={t('settings.profile_x', { defaultValue: 'X (anciennement Twitter)' })} vis={vis.x} onVis={setV('x')}>
              <Input value={f.x} onChange={e => set('x', e.target.value)}
                placeholder={t('settings.profile_x_ph', { defaultValue: 'Votre identifiant X (anciennement Twitter)' })} />
            </Field>
    
            <Field label="Bluesky" vis={vis.bluesky} onVis={setV('bluesky')}>
              <Input value={f.bluesky} onChange={e => set('bluesky', e.target.value)}
                placeholder={t('settings.profile_bluesky_ph', { defaultValue: 'Pseudo Bluesky' })} />
            </Field>
    
            <Field label={t('settings.profile_fediverse', { defaultValue: 'Fediverse (ex. Mastodon)' })} vis={vis.fediverse} onVis={setV('fediverse')}>
              <Input value={f.fediverse} onChange={e => set('fediverse', e.target.value)}
                placeholder={t('settings.profile_fediverse_ph', { defaultValue: 'Votre pseudo' })} />
            </Field>
    
            <Field label={t('settings.profile_organization', { defaultValue: 'Organisation' })} vis={vis.organization} onVis={setV('organization')}>
              <Input value={f.organization} onChange={e => set('organization', e.target.value)}
                placeholder={t('settings.profile_organization_ph', { defaultValue: 'Votre organisation' })} />
            </Field>
    
            <Field label={t('settings.profile_job', { defaultValue: 'Fonction' })} vis={vis.jobFunction} onVis={setV('jobFunction')}>
              <Input value={f.jobFunction} onChange={e => set('jobFunction', e.target.value)}
                placeholder={t('settings.profile_job_ph', { defaultValue: 'Votre fonction' })} />
            </Field>
    
            <Field label={t('settings.profile_title', { defaultValue: 'Titre' })} vis={vis.title} onVis={setV('title')}>
              <Input value={f.title} onChange={e => set('title', e.target.value)}
                placeholder={t('settings.profile_title_ph', { defaultValue: 'Votre titre' })} />
            </Field>
    
            <Field label={t('settings.profile_introduction', { defaultValue: 'Présentation' })}
              vis={vis.introduction} onVis={setV('introduction')} className="md:col-span-2"
              hint={t('settings.profile_introduction_hint', { defaultValue: '4 000 caractères au maximum.' })}>
              <Textarea value={f.introduction} onChange={e => set('introduction', e.target.value)} className="min-h-[150px]"
                maxLength={4000}
                placeholder={t('settings.profile_introduction_ph', { defaultValue: 'Quelques lignes sur vous. Le format Markdown est pris en charge.' })} />
            </Field>
            </Section>
  )
}
