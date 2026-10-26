/**
 * Code-behind of `StartPageDemo.kbcontrol` (converted from `StartPageDemo.tsx` by @kubuno/views-migrate).
 */
import { StartPage } from "@ui"
import { noop } from "./PreviewDemos"

import { ViewBase } from './StartPageDemo.kbcontrol'

export class StartPageDemo extends ViewBase {
  /** `<StartPage>`, rendered by a ReactHost. */
  get StartPage() {
    return StartPage
  }

  get start_page_props() {
    return this.memo('start_page_props', [], () => ({ recentItems: [
          { id: '1', name: "Annual report.docx", subtitle: "June 30, 2026", onClick: noop },
          { id: '2', name: 'Budget.xlsx', subtitle: "June 28, 2026", onClick: noop },
          { id: '3', name: "Presentation.pptx", subtitle: "June 21, 2026", onClick: noop },
        ], tabs: [
          {
            id: 'modeles',
            label: "Templates",
            content: (
              <div className="grid grid-cols-3 gap-3 p-4">
                {["Blank", 'CV', "Letter", "Invoice", "Report", "Poster"].map((m) => (
                  <div key={m} className="aspect-[3/4] rounded-lg border border-border bg-surface-1 flex items-end p-2 text-xs text-text-secondary hover:border-primary cursor-pointer">
                    {m}
                  </div>
                ))}
              </div>
            ),
          },
          { id: 'recents', label: "Recent", content: <div className="p-4 text-sm text-text-tertiary">Your recent documents…</div> },
        ] }))
  }

}

export default StartPageDemo.component()
