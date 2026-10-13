import type { UserControlProp } from './types.js';
/** The `x:Props` type named by a `.kbcontrol`'s root element, if any. */
export declare function propsTypeOf(kbcontrolFile: string): string | null;
/**
 * The members of a user control's `x:Props` type, or `undefined` when it has none (or cannot be read): the
 * control then keeps the earlier pass-through behaviour.
 */
export declare function extractUserControlProps(kbcontrolFile: string, codeBehindFile: string | null): UserControlProp[] | undefined;
