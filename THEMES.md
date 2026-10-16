# Kubuno - Thèmes empaquetés (skins)

Un **thème** Kubuno est un paquet `.zip` que l'administrateur injecte. Au-delà des
couleurs, un thème peut redéfinir le **CSS**, la **structure (HTML)** et le
**comportement (JS)** des « objets » d'interface - des primitives (`Button`,
`Badge`…) aux composants complexes - **globalement** ou pour des **modules ciblés**.

## 1. Structure du paquet

```
mon-theme.zip
├── theme.json            # manifeste (obligatoire, à la racine)
├── global.css            # feuille globale (optionnelle)
├── global.js             # script global d'overrides (optionnel)
├── modules/
│   ├── calendar.css      # apparence ciblée du module "calendar"
│   └── calendar.js       # overrides de composants pour "calendar"
└── assets/               # polices, images… (optionnel)
```

Extensions autorisées : `json, css, js, mjs, map, svg, png, jpg, jpeg, webp, gif,
woff, woff2, ttf, otf`. Limites : 400 fichiers, 8 Mio/fichier, 40 Mio décompressé,
25 Mio pour l'archive. L'extraction rejette tout chemin absolu ou `..`.

## 2. Manifeste `theme.json`

```jsonc
{
  "id": "neon-night",            // a-z 0-9 - _  (≤ 64), unique
  "name": "Neon Night",
  "color_scheme": "dark",        // "light" | "dark"
  "version": "1.0.0",            // optionnel
  "theme_api_version": 1,        // version du contrat (host = 1)

  // Variables CSS posées sur :root - toujours appliquées (sans risque).
  "vars": {
    "--color-primary": "#00e5ff",
    "--color-surface-0": "#0d0f1a",
    "--body-bg": "#080a12"
  },

  // Skin global : s'applique partout dans l'hôte.
  "global": { "css": "global.css", "script": "global.js" },

  // Skins par module : SEULS les modules listés sont affectés ; tout autre
  // module garde son apparence par défaut.
  "modules": {
    "calendar": { "css": "modules/calendar.css", "script": "modules/calendar.js" },
    "office":   { "css": "modules/office.css" }
  }
}
```

Un thème « vars-only » (sans `global`/`modules`) reste valide : il ne fait que
changer les couleurs - c'est le format historique, importable aussi en simple JSON.

## 3. CSS

- La CSS globale et celle des modules sont injectées via `<link>` en **même
  origine** (`/api/v1/themes/<id>/…`). Une CSS de module ne doit cibler que
  `[data-module="<id>"] …` (l'hôte pose cet attribut sur la zone du module).
- Les variables `--color-*`, `--body-bg`, `--radius-*`, `--font-family-*` du
  thème de base (cf. `web/src/theme.css`) sont surchargeables.

## 4. Scripts d'override (HTML + JS des composants)

Un script (`global.js` ou `modules/<id>.js`) **n'importe rien** : l'hôte lui
passe son API (mêmes singletons React/`@ui`). Il exporte `register(api)` :

```js
export function register(api) {
  const { React, ui, components, theme, moduleId } = api

  function NeonButton(props) {
    return React.createElement('button', {
      ...props,
      style: { background: 'linear-gradient(135deg,#00e5ff,#7c4dff)', ...props.style },
    }, props.children)
  }

  // Override global d'un objet du catalogue :
  components.register('ui.Button', NeonButton)

  // Override ciblé sur un module :
  // components.register('calendar.EventChip', MonChip, { moduleId: 'calendar' })
}
```

`api` :

| Champ | Description |
|---|---|
| `React` | l'instance React unique de l'hôte (créez vos composants avec) |
| `ui` | l'ensemble des primitives `@ui` (base + thématisables) |
| `components.register(key, Comp, { moduleId? })` | enregistre un override (global ou ciblé) |
| `components.unregister(key, { moduleId? })` | retire un override |
| `theme` | `{ id, name, colorScheme, vars }` |
| `moduleId` | défini pour un script de module |

La résolution d'un objet thématisable est : **override de module → override
global → implémentation par défaut**.

## 5. Catalogue des clés thématisables

Le contrat versionné des « objets » qu'un thème peut remplacer. Déclaré côté hôte
via `themed('<clé>', Base)` (`web/src/ui/themeRegistry.tsx`).

| Clé | Objet | Statut |
|---|---|---|
| `ui.Button` | Bouton primitif | câblé |
| `ui.Badge` | Pastille | câblé |
| `ui.Input` | Champ texte | câblé |
| `ui.NumberInput` | Champ numérique | câblé |
| `ui.Textarea` | Zone de texte | câblé |
| `ui.RichText` | Éditeur de texte riche | câblé |
| `ui.Checkbox` | Case à cocher | câblé |
| `ui.Radio` | Bouton radio | câblé |
| `ui.Toggle` | Bascule (interrupteur) | câblé |
| `ui.FloatCheckbox` | Case à cocher flottante | câblé |
| `ui.Separator` | Séparateur | câblé |
| `ui.Spinner` | Indicateur de chargement | câblé |
| `ui.RangeSlider` | Curseur (slider) | câblé |
| `ui.Dropdown` | Sélecteur déroulant | câblé |
| `ui.DatePicker` | Sélecteur de date/heure | câblé |
| `ui.FontPicker` | Sélecteur de police | câblé |
| `ui.MenuDropdown` | Menu contextuel | câblé |
| `ui.Tabs` | Onglets | câblé |
| `ui.StartPage` | Page d'accueil de module | câblé |
| `ui.KubunoLogo` | Logo | câblé |
| `ui.ColorPicker` | Sélecteur de couleur | câblé |
| `ui.ColorField` | Champ de couleur | câblé |
| `ui.ColorSwatchPicker` | Nuancier | câblé |
| `ui.GradientPicker` | Sélecteur de dégradé | câblé |
| `ui.GradientField` | Champ de dégradé | câblé |
| `ui.AnchoredPopover` | Popover ancré | câblé |
| `ui.FloatingWindow` | Fenêtre flottante | câblé |
| `ui.ResizeHandle` | Poignée de redimensionnement | câblé |
| `ui.ConfirmDialog` | Boîte de confirmation | câblé |
| `ui.ConflictDialog` | Boîte de conflit | câblé |

> Tous les composants visuels de `@ui` passent par `themed()` (ils rendent leur
> implémentation par défaut tant qu'aucun override n'est enregistré). Seuls les
> hooks (`useMenuDropdown`, `useResizableWidth`…), utilitaires (`harmonyColors`,
> convertisseurs de couleur…) et types ne sont pas thématisables. `themed()`
> forwarde les `ref` (ex. `Input` est en `forwardRef`) et préserve les génériques
> (ex. `Tabs<T>`).
| `shell.search` | Barre de recherche du core | câblé |
| `shell.nav-item` | Élément de navigation (sidebar) | câblé |
| `shell.*` | autres éléments de coquille | à câbler au besoin |
| `drive.file-card` | Tuile de fichier (grille) | câblé |
| `drive.folder-card` | Carte de dossier (grille) | câblé |
| `drive.file-row` | Ligne de fichier (liste) | câblé |
| `drive.folder-row` | Ligne de dossier (liste) | câblé |
| `drive.toolbar` | Barre tri/filtre/vue | câblé |
| `drive.breadcrumb` | Fil d'Ariane | câblé |
| `drive.upload-panel` | Panneau d'upload | câblé |
| `<module>.*` | objets complexes exposés par un module | déclarés par le module |

> Les objets câblés sont surchargeables sans changement visuel par défaut
> (`themed(clé, Base)` rend la base tant qu'aucun override n'est enregistré).

> Un module rend un de ses composants thématisable en l'enveloppant avec
> `themed('<module>.<objet>', Base)` (importé de `@kubuno/sdk` ou `@ui`). Toute
> primitive `@ui` consommée par le module est déjà thématisable de fait.

## 6. Sécurité - exécution des scripts (opt-in)

La **CSS est toujours appliquée**. Le **JS d'un thème ne s'exécute pas** tant que
l'administrateur n'a pas explicitement **autorisé les scripts** de ce thème
(console admin → Apparence → bascule « Autoriser les scripts », avertissement).

- La confiance est stockée côté serveur (`appearance.trusted_themes`).
- Un script tourne dans le contexte de l'hôte (accès DOM/réseau) : n'autorisez
  que des thèmes dont vous maîtrisez la provenance.
- À la réimportation d'un thème, sa confiance est **réinitialisée**.

## 7. Importer / gérer

- **Console admin → Apparence** : « Importer un .zip » (ou « Importer » pour un
  JSON vars-only), bascule de confiance des scripts, suppression.
- **API** :
  - `POST /api/v1/admin/themes/import` (multipart, champ `file` = `.zip`)
  - `GET  /api/v1/themes` (public) - manifestes + `has_scripts`, `scripts_enabled`, `assets_base`
  - `GET  /api/v1/themes/<id>/<path>` (public) - assets du thème
  - `PATCH /api/v1/admin/themes/<id>/trust` `{ "scripts_enabled": true|false }`
  - `DELETE /api/v1/admin/themes/<id>`

Le thème actif est choisi par l'utilisateur (Paramètres → Thèmes, suit l'appareil)
au-dessus du défaut d'instance (`appearance.theme`).
