/**
 * The parts of `ReportDocument.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Download, Printer } from "lucide-react"
import { Button, Dropdown, Toggle } from "@ui"
import WatermarkPanel from "./paged/WatermarkPanel"
import type { Orientation } from "./paged/geometry"
import type { ReportDocument } from './ReportDocument'

export function Part1({ barRef, crumbH, periodId, onPeriod, periodOptions, paper, setPaper, t, orientation, setOrientation, cover, setCover, watermark, setWatermark, exportCsv }: { barRef: NonNullable<ReportDocument['barRef']>; crumbH: NonNullable<ReportDocument['crumbH']>; periodId: NonNullable<ReportDocument['props']['periodId']>; onPeriod: NonNullable<ReportDocument['props']['onPeriod']>; periodOptions: NonNullable<ReportDocument['periodOptions']>; paper: NonNullable<ReportDocument['paper']>; setPaper: NonNullable<ReportDocument['setPaper']>; t: NonNullable<ReportDocument['tr']>; orientation: NonNullable<ReportDocument['orientation']>; setOrientation: NonNullable<ReportDocument['setOrientation']>; cover: NonNullable<ReportDocument['cover']>; setCover: NonNullable<ReportDocument['setCover']>; watermark: NonNullable<ReportDocument['watermark']>; setWatermark: NonNullable<ReportDocument['setWatermark']>; exportCsv: NonNullable<ReportDocument['exportCsv']> }) {
  return (
    <div
            ref={barRef}
            className="no-print sticky z-20 -mx-6 mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-0 px-6 py-3"
            style={{ top: crumbH - 24 }}
          >
            <Dropdown value={periodId} onChange={onPeriod} options={periodOptions} width={200} focusable />
            <div className="flex flex-wrap items-center gap-2">
              {/* The three things that change where the cuts fall. They belong next
                  to "Imprimer" because that is when somebody wonders about them. */}
              <Dropdown
                value={paper}
                onChange={setPaper}
                options={[
                  { value: 'a4',     label: 'A4' },
                  { value: 'letter', label: t('admin.rep_paper_letter') },
                ]}
                width={110}
                focusable
              />
              <Dropdown
                value={orientation}
                onChange={v => setOrientation(v as Orientation)}
                options={[
                  { value: 'portrait',  label: t('admin.rep_portrait') },
                  { value: 'landscape', label: t('admin.rep_landscape') },
                ]}
                width={140}
                focusable
              />
              <Toggle
                size="sm"
                label={t('admin.rep_cover')}
                checked={cover}
                onChange={e => setCover(e.currentTarget.checked)}
              />
              {/* The stamp opens its own panel rather than sitting in the toolbar:
                  it is a picture OR words, with a size, an opacity and an angle —
                  four controls that have no business crowding the print button. */}
              <WatermarkPanel value={watermark} onChange={setWatermark} />
              <Button
                variant="secondary"
                icon={<Download size={15} />}
                onClick={exportCsv}
              >
                {t('admin.rep_export')}
              </Button>
              <Button
                variant="primary"
                icon={<Printer size={15} />}
                onClick={() => window.print()}
              >
                {t('admin.rep_print')}
              </Button>
            </div>
          </div>
  )
}
