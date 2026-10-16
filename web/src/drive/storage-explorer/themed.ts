/**
 * Themeable Drive objects - a theme can override these (markup/behaviour) while
 * they are untouched by default (`themed` returns the base component when no
 * override is registered). Keys form the `drive.*` part of the theme catalog
 * (cf. THEMES.md).
 */
import { themed } from '@ui'
import UploadPanelBase from '../UploadPanel'
import { FolderCardBase, FileCardBase } from './cards'
import { FileRowBase, FolderRowBase } from './rows'
import { SortFilterBarBase } from './toolbars'
import { StorageBreadcrumbBase } from './StorageBreadcrumb'

export const FolderCard        = themed('drive.folder-card', FolderCardBase)
export const FileCard          = themed('drive.file-card',   FileCardBase)
export const FileRow           = themed('drive.file-row',    FileRowBase)
export const FolderRow         = themed('drive.folder-row',  FolderRowBase)
export const SortFilterBar     = themed('drive.toolbar',     SortFilterBarBase)
export const StorageBreadcrumb = themed('drive.breadcrumb',  StorageBreadcrumbBase)
export const UploadPanel       = themed('drive.upload-panel', UploadPanelBase)
