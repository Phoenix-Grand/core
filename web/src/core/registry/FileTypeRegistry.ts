// Registre des TYPES DE FICHIERS pris en charge par les modules.
//
// Principe : tout module (ou sous-module) qui manipule des fichiers DÉCLARE ici,
// dans son register.ts, les MIME types et/ou extensions qu'il sait ouvrir. Le
// module `files` (parcours, « ouvrir avec », StartPage…) s'appuie ensuite sur
// ces déclarations pour FILTRER les fichiers pertinents - au lieu de listes de
// MIME codées en dur et dupliquées dans chaque module.

export interface FileTypeDeclaration {
  /** Identité du module/sous-module déclarant (ex. 'office-documents', 'code'). */
  moduleId:      string
  /** Libellé affichable (ex. « Documents »). */
  label:         string
  /** MIME types exacts (ex. 'application/pdf'). */
  mimeTypes?:    string[]
  /** Préfixes MIME (ex. 'image/', 'text/'). */
  mimePrefixes?: string[]
  /** Extensions sans point, insensibles à la casse (ex. 'docx', 'odt'). */
  extensions?:   string[]
  /** Nom d'icône Lucide pour ce type de fichier (ex. 'Layers'). */
  icon?:         string
  /** Ouvre le fichier dans l'application associée (résout l'entité + navigue). */
  open?:         (file: FileOpenTarget, navigate: FileNavigate) => void
}

export type FileNavigate = (path: string) => void
export interface FileOpenTarget { id: string; name: string; mime_type: string }

export interface FileLike { mime_type: string; name: string }

const decls = new Map<string, FileTypeDeclaration>()

function ext(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function declMatches(d: FileTypeDeclaration, file: FileLike): boolean {
  const mime = file.mime_type || ''
  if (d.mimeTypes?.includes(mime)) return true
  if (d.mimePrefixes?.some(p => mime.startsWith(p))) return true
  const e = ext(file.name)
  if (e && d.extensions?.includes(e)) return true
  return false
}

export const FileTypeRegistry = {
  register(d: FileTypeDeclaration): void {
    decls.set(d.moduleId, {
      ...d,
      extensions: (d.extensions ?? []).map(x => x.trim().toLowerCase().replace(/^\./, '')),
    })
  },

  get(moduleId: string): FileTypeDeclaration | undefined {
    return decls.get(moduleId)
  },

  all(): FileTypeDeclaration[] {
    return [...decls.values()]
  },

  /** Le fichier correspond-il à la déclaration du module ? (pas de déclaration → tout passe) */
  matches(moduleId: string, file: FileLike): boolean {
    const d = decls.get(moduleId)
    return d ? declMatches(d, file) : true
  },

  /** Prédicat de filtrage prêt à l'emploi pour un module. */
  matcher(moduleId: string): (file: FileLike) => boolean {
    const d = decls.get(moduleId)
    return (file: FileLike) => (d ? declMatches(d, file) : true)
  },

  /** Modules déclarés capables d'ouvrir ce fichier (pour « ouvrir avec »). */
  handlersFor(file: FileLike): FileTypeDeclaration[] {
    return [...decls.values()].filter(d => declMatches(d, file))
  },

  /** Déclarations correspondantes qui savent OUVRIR le fichier (handler `open`). */
  openersFor(file: FileLike): FileTypeDeclaration[] {
    return [...decls.values()].filter(d => declMatches(d, file) && !!d.open)
  },

  /** Nom d'icône de l'app associée au fichier (1er match avec icône), sinon undefined. */
  iconFor(file: FileLike): string | undefined {
    return [...decls.values()].find(d => declMatches(d, file) && !!d.icon)?.icon
  },

  /** Chaîne `accept` (MIME + extensions) pour un <input type=file> / upload. */
  acceptString(moduleId: string): string {
    const d = decls.get(moduleId)
    if (!d) return ''
    const exts = (d.extensions ?? []).map(e => '.' + e)
    return [...(d.mimeTypes ?? []), ...exts].join(',')
  },
}
