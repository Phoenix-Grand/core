/**
 * The extension point for "choose a point on Earth".
 *
 * ## Why an extension point and not a map
 *
 * The console knows a building has a latitude and a longitude; it has no
 * business knowing what a tile server is. Two number fields are a correct — if
 * charmless — way to enter a coordinate, and they are what the core ships,
 * because they work on an instance that has nothing else installed.
 *
 * A module that renders maps can do far better, and this key is how it says so.
 * The core never names that module: it asks the registry whether *someone*
 * active has claimed the key, and falls back to its own two fields otherwise.
 * That is the same bargain as the file viewers — the host owns the hole, the
 * module owns the filling.
 *
 * ## The contract
 *
 * Coordinates travel as STRINGS, deliberately. The form holds what the operator
 * typed, and "" is a real state that a number cannot represent: a half-typed
 * "-0." is not zero, and an empty field is not the Gulf of Guinea.
 *
 * A provider must set BOTH values or NEITHER. The server refuses a lone
 * latitude — half a coordinate places nothing and would travel on as a fact.
 */
export const GEO_POINT_FIELD = 'geo-point-field'

export interface GeoPointFieldProps {
  /** Decimal degrees as typed, or `''` when unset. */
  latitude:  string
  longitude: string
  /** What the operator entered as the postal address, when the form has one.
   *  A provider may use it to start somewhere near the answer; it is a hint,
   *  never an instruction, and it may well be empty. */
  address?:  string
  disabled?: boolean
  /** Always both, or both empty. */
  onChange: (latitude: string, longitude: string) => void
}
