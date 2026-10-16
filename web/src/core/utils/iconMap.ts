import {
  Home, Star, Trash2, Clock, Cloud, Image, Calendar,
  MessageSquare, FileText, CheckSquare, BookOpen,
  FolderOpen, Share2, Inbox, Send, ShieldAlert,
  StickyNote, ClipboardList, Sparkles, BookImage, Box, Palette,
  Archive, Film, Network, PenTool, TableProperties, Heart,
  Tv, Music, Code2, Users, Clapperboard, MailIcon as Mail, Bot,
  Contact, LayoutTemplate, FolderKanban, Briefcase,
  Layers, BarChart3, Zap, Workflow, Sigma,
  Activity, HardDrive, KeyRound, UserCircle, ShieldCheck, Gauge,
  // Names modules use for their admin pages (`[[setting_groups]]`). A name
  // missing here renders WITHOUT a glyph, which reads as a broken row next to
  // its siblings - so this set has to cover what an admin page is plausibly
  // about, not just what one module happens to declare today.
  Server, Lock, Filter, SlidersHorizontal, Globe, Bell, Database, Plug,
  AtSign, Mails, ShieldOff, Signature, Route, Gavel, Wrench, Key, FileCog,
  // Declared by installed modules as their own glyph.
  AppWindow, DraftingCompass, MessagesSquare, Map, BookMarked,
  type LucideIcon,
} from 'lucide-react'

export const ICON_MAP: Record<string, LucideIcon> = {
  Home, Star, Trash2, Clock, Cloud, Image, Calendar,
  MessageSquare, FileText, CheckSquare, BookOpen,
  FolderOpen, Share2, Inbox, Send, ShieldAlert,
  StickyNote, ClipboardList, Sparkles, BookImage, Box, Palette,
  Archive, Film, Network, PenTool, TableProperties, Heart,
  Tv, Music, Code2, Users, Clapperboard, Mail, Bot,
  Contact, LayoutTemplate, FolderKanban, Briefcase,
  Layers, BarChart3, Zap, Workflow, Sigma,
  Activity, HardDrive, KeyRound, UserCircle, ShieldCheck, Gauge,
  Server, Lock, Filter, SlidersHorizontal, Globe, Bell, Database, Plug,
  AtSign, Mails, ShieldOff, Signature, Route, Gavel, Wrench, Key, FileCog,
  AppWindow, DraftingCompass, MessagesSquare, Map, BookMarked,
}

export function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Cloud
}

/**
 * Same lookup WITHOUT the fallback - for places where an unknown name must show
 * nothing rather than a stand-in.
 *
 * A sidebar entry has to be clickable, so `getIcon` owes it a glyph. A decorative
 * icon does not: a menu of five module pages where the two the core happens to
 * know show an icon and the three others show a cloud reads as three broken
 * rows. No icon at all is the honest rendering of "this name is not one we ship".
 */
export function findIcon(name: string | null | undefined): LucideIcon | null {
  return (name && ICON_MAP[name]) || null
}
