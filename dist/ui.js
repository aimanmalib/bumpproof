export function useColor(env, isTTY) {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '')
        return false;
    if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0')
        return true;
    return Boolean(isTTY);
}
export function makePaint(color) {
    const wrap = (open, close) => (s) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
    return { ok: wrap(32, 39), fail: wrap(31, 39), dim: wrap(2, 22), bold: wrap(1, 22) };
}
