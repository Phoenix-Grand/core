/**
 * The definition row and the em-dash placeholder are shared with the other
 * record sheets — three of them draw the same row now, so it lives one level up
 * (`inline-edit/Field`) and is re-exported here for the tabs that already
 * import it from this file.
 */
export { orDash, default as Field } from '../../inline-edit/InlineEditField'
