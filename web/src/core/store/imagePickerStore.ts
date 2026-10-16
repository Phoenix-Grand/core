import { create } from 'zustand'

/** What the caller gets back: either a URL to reference, or a file to store. */
export type ImagePickResult =
  | { kind: 'url';  url: string }
  | { kind: 'file'; file: File }

export interface ImagePickerOptions {
  title?: string
  /** Source ids to hide, e.g. ['webcam'] where a capture makes no sense. */
  exclude?: string[]
  /** Let the user bring back several images at once (upload tab). */
  multiple?: boolean
}

interface Entry extends ImagePickerOptions {
  resolve: (value: ImagePickResult[] | null) => void
}

interface Store {
  current: Entry | null
  open:   (options?: ImagePickerOptions) => Promise<ImagePickResult[] | null>
  /** Sources hand over one or several results; the dialog closes either way. */
  pick:   (value: ImagePickResult | ImagePickResult[]) => void
  cancel: () => void
}

export const useImagePickerStore = create<Store>((set, get) => ({
  current: null,
  open: (options = {}) =>
    new Promise<ImagePickResult[] | null>(resolve => set({ current: { ...options, resolve } })),
  pick:   (value) => {
    get().current?.resolve(Array.isArray(value) ? value : [value])
    set({ current: null })
  },
  cancel: () => { get().current?.resolve(null); set({ current: null }) },
}))

/**
 * Opens the project's image picker and resolves with the chosen image, or null
 * if the user closes it. THE way to insert or upload an image anywhere in the
 * app - modules never build their own file input for that.
 *
 * Requires `<ImagePickerHost />` mounted once (App.tsx).
 */
export const openImagePicker = async (options?: ImagePickerOptions): Promise<ImagePickResult | null> =>
  (await useImagePickerStore.getState().open(options))?.[0] ?? null

/** Same picker, allowing several images at once. */
export const openImagePickerMany = (options?: ImagePickerOptions): Promise<ImagePickResult[] | null> =>
  useImagePickerStore.getState().open({ ...options, multiple: true })

/**
 * Same picker, but always resolves to a File - for the callers that UPLOAD the
 * image rather than merely reference it. A picked URL is fetched here, because
 * an authenticated Drive/Photos URL is useless to whoever reads the result
 * later (an anonymous visitor, another server).
 *
 * Returns null if the user closes the picker.
 */
export async function pickImageFile(options?: ImagePickerOptions): Promise<File | null> {
  const picked = await openImagePicker(options)
  return picked ? toFile(picked) : null
}

/** Same, for several images at once. */
export async function pickImageFiles(options?: ImagePickerOptions): Promise<File[]> {
  const picked = await openImagePickerMany(options)
  return picked ? Promise.all(picked.map(toFile)) : []
}

async function toFile(picked: ImagePickResult): Promise<File> {
  if (picked.kind === 'file') return picked.file
  const res = await fetch(picked.url)
  if (!res.ok) throw new Error(`Image inaccessible (${res.status})`)
  const blob = await res.blob()
  const name = picked.url.split('/').pop()?.split('?')[0] || 'image'
  return new File([blob], name, { type: blob.type || 'image/*' })
}
