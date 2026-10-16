import React from 'react'

// True while the explorer is in touch multi-selection mode (at least one item
// selected on a mobile viewport). Cards read it to keep their checkbox visible
// even when the item itself isn't selected yet, so the whole grid reads as a
// pickable set - the long-press-then-tap-to-add flow.
export const SelectingCtx = React.createContext(false)
