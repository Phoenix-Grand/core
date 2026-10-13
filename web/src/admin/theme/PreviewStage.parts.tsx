/**
 * The parts of `PreviewStage.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { PortalHostContext } from "@ui"
import type { PreviewStage } from './PreviewStage'

export function Part1({ setNode, width, height, node, children }: { setNode: NonNullable<PreviewStage['setNode']>; width: NonNullable<PreviewStage['width']>; height: NonNullable<PreviewStage['height']>; node: PreviewStage['node']; children: PreviewStage['props']['children'] }) {
  return (
    <div
            ref={setNode}
            className="relative overflow-hidden rounded-xl border border-border bg-surface-1"
            style={{ width, height }}
          >
            <PortalHostContext.Provider value={node}>
              {node && children}
            </PortalHostContext.Provider>
          </div>
  )
}
